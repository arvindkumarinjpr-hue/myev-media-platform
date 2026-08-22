import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { Prisma, Project } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { SlugReservationService } from "../workspaces/slug-reservation.service";
import type { CreateProjectDto } from "./dto/create-project.dto";
import type { UpdateProjectDto } from "./dto/update-project.dto";

interface RequestContext {
  ipAddress?: string;
}

const PROJECT_ACTIVE_KNOWLEDGE_PACK_INCLUDE = {
  activeKnowledgePack: { select: { publicId: true } },
} satisfies Prisma.ProjectInclude;

export type ProjectWithActiveKnowledgePack = Prisma.ProjectGetPayload<{ include: typeof PROJECT_ACTIVE_KNOWLEDGE_PACK_INCLUDE }>;

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slugReservationService: SlugReservationService,
    private readonly audit: AuditService,
  ) {}

  async create(workspaceId: string, actorUserId: string, dto: CreateProjectDto, context: RequestContext): Promise<Project> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: { workspaceId, name: dto.name, slug: dto.slug, ownerId: actorUserId, createdById: actorUserId },
      });
      // Same pattern as workspace creation (Module 1C Engineering Plan
      // §1): resource insert, then reservation insert, same transaction —
      // the reservation's own UNIQUE(workspace_id, slug) is the real
      // collision check.
      await this.slugReservationService.reserveProjectSlug(tx, workspaceId, project.id, dto.slug);

      await this.audit.recordWithinTransaction(tx, {
        action: "PROJECT_CREATED",
        actorUserId,
        workspaceId,
        entityType: "project",
        entityId: project.publicId,
        ipAddress: context.ipAddress,
      });

      return project;
    });
  }

  async list(workspaceId: string): Promise<ProjectWithActiveKnowledgePack[]> {
    return this.prisma.project.findMany({
      where: { workspaceId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      include: PROJECT_ACTIVE_KNOWLEDGE_PACK_INCLUDE,
    });
  }

  async findOne(workspaceId: string, projectPublicId: string): Promise<ProjectWithActiveKnowledgePack> {
    const project = await this.prisma.project.findFirst({
      where: { workspaceId, publicId: projectPublicId, deletedAt: null },
      include: PROJECT_ACTIVE_KNOWLEDGE_PACK_INCLUDE,
    });
    if (!project) {
      // Cross-workspace / non-existent probe — enumeration-safe, same rule
      // as WorkspaceContextGuard (Module 1C Engineering Plan §2.B).
      throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
    }
    return project;
  }

  /**
   * Phase 2.5 — `knowledgePackId` here is the explicit reassignment
   * capability MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §8 calls a
   * dependency, not yet designed. No new permission (reuses PROJECT_UPDATE,
   * already governing every other Project field) and no new endpoint —
   * this is just another field on the same PATCH. Never touched by
   * Knowledge Pack supersession/archival itself (Owner Decision 7 — no
   * automatic reassignment, ever); this is the only place the FK moves.
   */
  async update(workspaceId: string, projectPublicId: string, actorUserId: string, dto: UpdateProjectDto, context: RequestContext): Promise<ProjectWithActiveKnowledgePack> {
    const project = await this.findOne(workspaceId, projectPublicId);
    const beforeState: Record<string, unknown> = { name: project.name, slug: project.slug };
    const afterStateExtra: Record<string, unknown> = {};

    // undefined = field omitted, leave unchanged. null = explicit
    // unassign. string = resolve to an Active, same-workspace Knowledge
    // Pack's internal id (ADR-013 — the internal id itself never crosses
    // this boundary either direction).
    let resolvedKnowledgePackId: string | null | undefined;
    if (dto.knowledgePackId !== undefined) {
      beforeState.knowledgePackPublicId = project.activeKnowledgePack?.publicId ?? null;
      if (dto.knowledgePackId === null) {
        resolvedKnowledgePackId = null;
        afterStateExtra.knowledgePackPublicId = null;
      } else {
        const pack = await this.prisma.knowledgePack.findFirst({
          where: { publicId: dto.knowledgePackId, workspaceId, deletedAt: null },
          select: { id: true, status: true },
        });
        if (!pack) {
          throw new UnprocessableEntityException({ code: "PROJECT_VALIDATION_FAILED", message: "knowledgePackId does not reference a Knowledge Pack in this workspace.", details: ["knowledgePackId"] });
        }
        if (pack.status !== "ACTIVE") {
          // A Project may only point at a currently-usable version — never
          // a Draft (not yet real), never an Archived one (deliberately
          // retired). This is also what keeps RESTRICT meaningful: the
          // predecessor's block can only ever be lifted by pointing
          // elsewhere, never by pointing at something not truly live.
          throw new UnprocessableEntityException({ code: "PROJECT_VALIDATION_FAILED", message: "A Project may only be assigned to an Active Knowledge Pack version.", details: ["knowledgePackId"] });
        }
        resolvedKnowledgePackId = pack.id;
        afterStateExtra.knowledgePackPublicId = dto.knowledgePackId;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.slug && dto.slug !== project.slug) {
        // Rename sequence identical to WorkspacesService.updateSettings:
        // new reservation first (the real enforcement point), then the
        // resource update. The old reservation is left untouched.
        await this.slugReservationService.reserveProjectSlug(tx, workspaceId, project.id, dto.slug);
      }

      const updated = await tx.project.update({
        where: { id: project.id },
        data: {
          ...(dto.name ? { name: dto.name } : {}),
          ...(dto.slug ? { slug: dto.slug } : {}),
          ...(resolvedKnowledgePackId !== undefined ? { knowledgePackId: resolvedKnowledgePackId } : {}),
        },
        include: PROJECT_ACTIVE_KNOWLEDGE_PACK_INCLUDE,
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "PROJECT_UPDATED",
        actorUserId,
        workspaceId,
        entityType: "project",
        entityId: project.publicId,
        ipAddress: context.ipAddress,
        beforeState,
        afterState: { name: updated.name, slug: updated.slug, ...afterStateExtra },
      });

      return updated;
    });
  }

  async archive(workspaceId: string, projectPublicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const project = await this.findOne(workspaceId, projectPublicId);
    if (project.status === "ARCHIVED") {
      throw new ConflictException({ code: "PROJECT_ALREADY_ARCHIVED", message: "Project is already archived." });
    }
    await this.prisma.project.update({ where: { id: project.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await this.audit.record({
      action: "PROJECT_ARCHIVED",
      actorUserId,
      workspaceId,
      entityType: "project",
      entityId: project.publicId,
      ipAddress: context.ipAddress,
    });
  }

  async restore(workspaceId: string, projectPublicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const project = await this.findOne(workspaceId, projectPublicId);
    if (project.status !== "ARCHIVED") {
      throw new ConflictException({ code: "PROJECT_NOT_ARCHIVED", message: "Project is not archived." });
    }
    await this.prisma.project.update({ where: { id: project.id }, data: { status: "ACTIVE", archivedAt: null } });
    await this.audit.record({
      action: "PROJECT_RESTORED",
      actorUserId,
      workspaceId,
      entityType: "project",
      entityId: project.publicId,
      ipAddress: context.ipAddress,
    });
  }
}
