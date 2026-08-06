import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Workspace } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AppConfig } from "../../config/configuration";
import { SlugReservationService } from "./slug-reservation.service";
import { WorkspaceCacheService } from "./workspace-cache.service";
import { assertValidCurrency, assertValidLocale, assertValidTimezone } from "./settings-validation.util";
import type { CreateWorkspaceDto } from "./dto/create-workspace.dto";
import type { UpdateWorkspaceDto } from "./dto/update-workspace.dto";

interface RequestContext {
  ipAddress?: string;
}

interface WorkspaceRow {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  status: string;
  ownerId: string;
  createdById: string;
  settings: unknown;
  featureFlags: unknown;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

interface MemberRow {
  id: string;
  publicId: string;
  workspaceId: string;
  userId: string;
  roleId: string;
  status: string;
  invitedById: string | null;
  joinedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const WORKSPACE_COLUMNS = `
  id, public_id AS "publicId", name, slug, status,
  owner_id AS "ownerId", created_by AS "createdById", settings, feature_flags AS "featureFlags",
  created_at AS "createdAt", updated_at AS "updatedAt", archived_at AS "archivedAt", deleted_at AS "deletedAt"
`;

const MEMBER_COLUMNS = `
  id, public_id AS "publicId", workspace_id AS "workspaceId", user_id AS "userId", role_id AS "roleId",
  status, invited_by AS "invitedById", joined_at AS "joinedAt", created_at AS "createdAt", updated_at AS "updatedAt"
`;

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slugReservationService: SlugReservationService,
    private readonly cache: WorkspaceCacheService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async create(creatorUserPublicId: string, dto: CreateWorkspaceDto): Promise<Workspace> {
    const creator = await this.prisma.user.findFirstOrThrow({ where: { publicId: creatorUserPublicId, deletedAt: null } });
    const defaults = this.config.get("workspace", { infer: true }).platformDefaults;

    if (dto.timezone) assertValidTimezone(dto.timezone);
    if (dto.locale) assertValidLocale(dto.locale);
    if (dto.currency) assertValidCurrency(dto.currency);

    const settings = {
      timezone: dto.timezone ?? defaults.timezone,
      locale: dto.locale ?? defaults.locale,
      currency: dto.currency ?? defaults.currency,
      dateFormat: dto.dateFormat ?? defaults.dateFormat,
    };

    const ownerRole = await this.prisma.role.findUniqueOrThrow({ where: { name: "Owner" } });

    return this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name: dto.name,
          slug: dto.slug,
          ownerId: creator.id,
          createdById: creator.id,
          settings,
        },
      });

      // Module 1C Engineering Plan §1: resource insert, then reservation
      // insert, same transaction — the reservation's own UNIQUE constraint
      // is the real collision check; the deferred composite FK on
      // workspaces.slug is validated at commit, guaranteeing the two never
      // disagree.
      await this.slugReservationService.reserveWorkspaceSlug(tx, workspace.id, dto.slug);

      await tx.workspaceMember.create({
        data: { workspaceId: workspace.id, userId: creator.id, roleId: ownerRole.id, status: "ACTIVE", joinedAt: new Date() },
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "WORKSPACE_CREATED",
        actorUserId: creator.id,
        workspaceId: workspace.id,
        entityType: "workspace",
        entityId: workspace.publicId,
      });

      return workspace;
    });
  }

  async listMine(userPublicId: string): Promise<Workspace[]> {
    const user = await this.prisma.user.findFirstOrThrow({ where: { publicId: userPublicId, deletedAt: null } });
    const memberships = await this.prisma.workspaceMember.findMany({
      where: { userId: user.id, status: "ACTIVE" },
      select: { workspaceId: true },
    });
    return this.prisma.workspace.findMany({
      where: { id: { in: memberships.map((m) => m.workspaceId) }, deletedAt: null },
    });
  }

  async findOne(workspaceId: string): Promise<Workspace> {
    return this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
  }

  async updateSettings(workspaceId: string, actorUserId: string, dto: UpdateWorkspaceDto, context: RequestContext): Promise<Workspace> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    const beforeState = { name: workspace.name, slug: workspace.slug, settings: workspace.settings };

    if (dto.timezone) assertValidTimezone(dto.timezone);
    if (dto.locale) assertValidLocale(dto.locale);
    if (dto.currency) assertValidCurrency(dto.currency);

    const currentSettings = (workspace.settings ?? {}) as Record<string, unknown>;
    const nextSettings = {
      ...currentSettings,
      ...(dto.timezone ? { timezone: dto.timezone } : {}),
      ...(dto.locale ? { locale: dto.locale } : {}),
      ...(dto.currency ? { currency: dto.currency } : {}),
      ...(dto.dateFormat ? { dateFormat: dto.dateFormat } : {}),
    };

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.slug && dto.slug !== workspace.slug) {
        // Module 1C Engineering Plan §1 rename sequence: new reservation
        // first (the real enforcement point — its UNIQUE constraint is
        // what a concurrent collision fails against), THEN the resource
        // update, in the same transaction. The old reservation is left
        // completely untouched — that's what makes the old slug
        // permanently unavailable, with no separate mechanism needed.
        await this.slugReservationService.reserveWorkspaceSlug(tx, workspaceId, dto.slug);
      }

      const result = await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          ...(dto.name ? { name: dto.name } : {}),
          ...(dto.slug ? { slug: dto.slug } : {}),
          settings: nextSettings,
        },
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "WORKSPACE_SETTINGS_UPDATED",
        actorUserId,
        workspaceId,
        entityType: "workspace",
        entityId: workspace.publicId,
        ipAddress: context.ipAddress,
        beforeState,
        afterState: { name: result.name, slug: result.slug, settings: result.settings },
      });

      return result;
    });

    return updated;
  }

  async archive(workspaceId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await this.audit.record({
      action: "WORKSPACE_ARCHIVED",
      actorUserId,
      workspaceId,
      entityType: "workspace",
      entityId: workspace.publicId,
      ipAddress: context.ipAddress,
    });
  }

  async restore(workspaceId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (workspace.status !== "ARCHIVED") {
      throw new ConflictException({ code: "WORKSPACE_NOT_ARCHIVED", message: "Workspace is not archived." });
    }
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { status: "ACTIVE", archivedAt: null } });
    await this.audit.record({
      action: "WORKSPACE_RESTORED",
      actorUserId,
      workspaceId,
      entityType: "workspace",
      entityId: workspace.publicId,
      ipAddress: context.ipAddress,
    });
  }

  async softDelete(workspaceId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const workspace = await this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
    if (workspace.status !== "ARCHIVED") {
      throw new ConflictException({ code: "WORKSPACE_NOT_ARCHIVED", message: "Workspace must be archived before it can be deleted." });
    }
    await this.prisma.workspace.update({ where: { id: workspaceId }, data: { status: "DELETED", deletedAt: new Date() } });
    await this.audit.record({
      action: "WORKSPACE_DELETED",
      actorUserId,
      workspaceId,
      entityType: "workspace",
      entityId: workspace.publicId,
      ipAddress: context.ipAddress,
    });
  }

  /**
   * Module 1C Engineering Plan §2.D′ (mandatory safeguard 4). Locks the
   * workspace row, then both membership rows together in one query ordered
   * by id ASC — a fixed order any concurrent transfer attempt on the same
   * pair of rows also uses, which is what rules out the classic two-
   * statement-opposite-order deadlock. Every raw-SQL column here is
   * explicitly aliased to its camelCase Prisma field name — the named,
   * deliberate fix for the exact bug Module 1B.1 shipped and caught in
   * SessionsService's row-locking query.
   */
  async transferOwnership(
    workspaceId: string,
    callerInternalId: string,
    targetUserPublicId: string,
    context: RequestContext,
  ): Promise<void> {
    const targetUser = await this.prisma.user.findFirst({ where: { publicId: targetUserPublicId, deletedAt: null } });
    if (!targetUser) {
      throw new BadRequestException({ code: "TARGET_NOT_ADMIN", message: "Target user is not an active Administrator of this workspace." });
    }

    await this.prisma.$transaction(async (tx) => {
      // ::uuid casts required — Postgres has no implicit uuid <-> text
      // comparison, and an unmarked parameter here fails at runtime with
      // "operator does not exist: uuid = text" (caught live against the
      // real database — see InvitationActivationService for where this
      // was first found).
      const [workspace] = await tx.$queryRaw<WorkspaceRow[]>`
        SELECT ${Prisma.raw(WORKSPACE_COLUMNS)} FROM workspaces WHERE id = ${workspaceId}::uuid FOR UPDATE
      `;
      if (!workspace) {
        throw new NotFoundException({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found." });
      }
      if (workspace.ownerId !== callerInternalId) {
        throw new ForbiddenException({ code: "NOT_WORKSPACE_OWNER", message: "Only the current Owner may transfer ownership." });
      }

      const members = await tx.$queryRaw<MemberRow[]>`
        SELECT ${Prisma.raw(MEMBER_COLUMNS)} FROM workspace_members
        WHERE workspace_id = ${workspaceId}::uuid AND user_id IN (${callerInternalId}::uuid, ${targetUser.id}::uuid)
        ORDER BY id ASC
        FOR UPDATE
      `;

      const currentOwnerMembership = members.find((m) => m.userId === callerInternalId);
      const targetMembership = members.find((m) => m.userId === targetUser.id);

      if (!currentOwnerMembership || currentOwnerMembership.status !== "ACTIVE") {
        throw new ForbiddenException({ code: "NOT_WORKSPACE_OWNER", message: "Only the current Owner may transfer ownership." });
      }
      if (!targetMembership || targetMembership.status !== "ACTIVE") {
        throw new BadRequestException({ code: "TARGET_NOT_ADMIN", message: "Target user is not an active Administrator of this workspace." });
      }

      const [ownerRole, adminRole] = await Promise.all([
        tx.role.findUniqueOrThrow({ where: { name: "Owner" } }),
        tx.role.findUniqueOrThrow({ where: { name: "Administrator" } }),
      ]);

      if (targetMembership.roleId !== adminRole.id) {
        throw new BadRequestException({ code: "TARGET_NOT_ADMIN", message: "Ownership can only be transferred to an existing Administrator." });
      }

      await tx.workspace.update({ where: { id: workspaceId }, data: { ownerId: targetUser.id } });
      await tx.workspaceMember.update({ where: { id: currentOwnerMembership.id }, data: { roleId: adminRole.id } });
      await tx.workspaceMember.update({ where: { id: targetMembership.id }, data: { roleId: ownerRole.id } });

      await this.audit.recordWithinTransaction(tx, {
        action: "WORKSPACE_OWNERSHIP_TRANSFERRED",
        actorUserId: callerInternalId,
        workspaceId,
        entityType: "workspace",
        entityId: workspace.publicId,
        ipAddress: context.ipAddress,
        afterState: {
          previousOwner: { userId: callerInternalId, roleBefore: "Owner", roleAfter: "Administrator" },
          newOwner: { userId: targetUser.id, roleBefore: "Administrator", roleAfter: "Owner" },
        },
      });

      // Post-condition check, still inside the transaction, before commit
      // — a failure here must prevent commit entirely, unlike 1B.1's
      // transaction-rollback bug where a throw discarded a write that
      // needed to survive. Here, nothing should survive if this fails.
      const activeOwnerCount = await tx.workspaceMember.count({ where: { workspaceId, roleId: ownerRole.id, status: "ACTIVE" } });
      if (activeOwnerCount !== 1) {
        throw new Error("INVARIANT_VIOLATION: workspace does not have exactly one ACTIVE Owner after transfer.");
      }
      const soleOwner = await tx.workspaceMember.findFirstOrThrow({ where: { workspaceId, roleId: ownerRole.id, status: "ACTIVE" } });
      const refreshedWorkspace = await tx.workspace.findUniqueOrThrow({ where: { id: workspaceId } });
      if (soleOwner.userId !== refreshedWorkspace.ownerId) {
        throw new Error("INVARIANT_VIOLATION: workspaces.owner_id does not match the sole ACTIVE Owner membership.");
      }
    });

    await Promise.all([
      this.cache.invalidateForMembershipChange(workspaceId, callerInternalId),
      this.cache.invalidateForMembershipChange(workspaceId, targetUser.id),
    ]);
  }
}
