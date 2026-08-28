import { randomUUID } from "crypto";
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type ContentItemStatus, type ContentReviewAction } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AppConfig } from "../../config/configuration";
import { ContentPermissionResolver, isSupportedContentType, type ContentPermissionAction } from "./content-permission.resolver";
import { ContentBodyValidator } from "./content-body-validator";
import { isSeriesProjectCompatible } from "./content-series-compatibility.util";
import type { CreateContentItemDto } from "./dto/create-content-item.dto";
import type { UpdateContentItemDto } from "./dto/update-content-item.dto";
import type { CreateContentVersionDto } from "./dto/create-content-version.dto";
import type { SubmitForReviewDto, ApproveContentDto, RejectContentDto } from "./dto/review-action.dto";
import type { UpdateContentItemProjectDto } from "./dto/update-content-item-project.dto";
import type { UpdateContentItemSeriesDto } from "./dto/update-content-item-series.dto";
import type { UpdateContentItemFeaturedMediaDto } from "./dto/update-content-item-featured-media.dto";

interface RequestContext {
  ipAddress?: string;
}

/** The caller — both id shapes a content-item operation needs: the
 * public id ContentPermissionResolver/PermissionResolver expect, and the
 * internal id used for createdBy/actorId columns and FK-safe writes. */
export interface ContentActor {
  publicId: string;
  internalId: string;
}

// projectId/seriesId/featuredMediaAssetId are all INTERNAL FKs — never
// client-facing. Every query whose result is ultimately returned to the
// controller includes these three relations' publicId alongside the raw
// row, so the controller serializer never has to (and never accidentally
// does) leak an internal id.
const WITH_PUBLIC_REFS = {
  project: { select: { publicId: true } },
  series: { select: { publicId: true } },
  featuredMediaAsset: { select: { publicId: true } },
} satisfies Prisma.ContentItemInclude;
export type ContentItemWithPublicRefs = Prisma.ContentItemGetPayload<{ include: typeof WITH_PUBLIC_REFS }>;

interface LockedContentItemRow {
  id: string;
  publicId: string;
  workspaceId: string;
  projectId: string | null;
  contentType: string;
  title: string;
  currentVersionId: string | null;
  seriesId: string | null;
  featuredMediaAssetId: string | null;
  status: ContentItemStatus;
  archivedFromStatus: ContentItemStatus | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

const CONTENT_ITEM_COLUMNS = `
  id,
  public_id AS "publicId",
  workspace_id AS "workspaceId",
  project_id AS "projectId",
  content_type AS "contentType",
  title,
  current_version_id AS "currentVersionId",
  series_id AS "seriesId",
  featured_media_asset_id AS "featuredMediaAssetId",
  status,
  archived_from_status AS "archivedFromStatus",
  created_by AS "createdById",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  archived_at AS "archivedAt",
  deleted_at AS "deletedAt"
`;

// Module 1E Engineering Plan's Archive/Restore Rules: an explicit
// allow-list, never inferred from "anything not already terminal". Only
// editorial, non-terminal statuses may be archived — DELETED and ARCHIVED
// itself are excluded; RENDERING/FAILED/SCHEDULED/PUBLISHED are reserved
// processing states 1E never sets on any row, so they're excluded too
// (defensive — unreachable in practice, since nothing in this module ever
// produces them).
const ARCHIVABLE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS", "REVIEW", "APPROVED"];
const EDITABLE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS"];

// Minimal projections — only the columns the locking logic below actually
// needs, unlike CONTENT_ITEM_COLUMNS above which serves every read site.
interface LockedSeriesRow {
  id: string;
  projectId: string | null;
  deletedAt: Date | null;
}
const CONTENT_SERIES_LOCK_COLUMNS = `id, project_id AS "projectId", deleted_at AS "deletedAt"`;

interface LockedMediaAssetRow {
  id: string;
  contentItemId: string | null;
  status: string;
}
const MEDIA_ASSET_LOCK_COLUMNS = `id, content_item_id AS "contentItemId", status`;

@Injectable()
export class ContentItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly permissions: ContentPermissionResolver,
    private readonly bodyValidator: ContentBodyValidator,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * Locks a content_items row by internal id (FOR UPDATE) and throws the
   * standard enumeration-safe 404 if it's missing or soft-deleted.
   * Shared by every mutating method below — each previously repeated this
   * exact query + guard inline.
   */
  private async lockItemOrThrow(tx: Prisma.TransactionClient, itemId: string): Promise<LockedContentItemRow> {
    const [locked] = await tx.$queryRaw<LockedContentItemRow[]>`
      SELECT ${Prisma.raw(CONTENT_ITEM_COLUMNS)} FROM content_items WHERE id = ${itemId}::uuid FOR UPDATE
    `;
    if (!locked || locked.deletedAt) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    return locked;
  }

  /** Shared by submit/approve/reject — identical shape, only action/comment differ. */
  private async createReviewEvent(
    tx: Prisma.TransactionClient,
    params: { workspaceId: string; contentItemId: string; contentVersionId: string; action: ContentReviewAction; comment: string | null; actorId: string },
  ): Promise<void> {
    await tx.contentReviewEvent.create({
      data: {
        id: randomUUID(),
        publicId: randomUUID(),
        workspaceId: params.workspaceId,
        contentItemId: params.contentItemId,
        contentVersionId: params.contentVersionId,
        action: params.action,
        comment: params.comment,
        actorId: params.actorId,
      },
    });
  }

  // ---------------------------------------------------------------------
  // Creation — atomic 5-step transaction (Module 1E Engineering Plan
  // "Content Creation Transaction"): create item with a null
  // currentVersionId, create version 1, link it, audit, commit. The
  // deferred constraint trigger permits the null in between; it is never
  // observable past commit.
  // ---------------------------------------------------------------------
  async create(workspace: { id: string }, actor: ContentActor, dto: CreateContentItemDto, context: RequestContext): Promise<ContentItemWithPublicRefs> {
    if (!isSupportedContentType(dto.contentType)) {
      throw new BadRequestException({ code: "CONTENT_TYPE_NOT_SUPPORTED", message: `Content type ${dto.contentType} is not yet supported.` });
    }
    const allowed = await this.permissions.can(actor.publicId, workspace.id, "create", dto.contentType);
    if (!allowed) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: `Missing required permission to create ${dto.contentType} content.` });
    }
    this.bodyValidator.validate(dto.contentType, dto.body);

    let projectInternalId: string | null = null;
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: dto.projectId, workspaceId: workspace.id, deletedAt: null } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectInternalId = project.id;
    }

    return this.prisma.$transaction(async (tx) => {
      // Step 1: create item, currentVersionId null.
      const itemId = randomUUID();
      await tx.contentItem.create({
        data: {
          id: itemId,
          publicId: randomUUID(),
          workspaceId: workspace.id,
          projectId: projectInternalId,
          contentType: dto.contentType,
          title: dto.title,
          status: "DRAFT",
          createdById: actor.internalId,
        },
      });

      // Step 2: create version 1.
      const version = await tx.contentVersion.create({
        data: {
          id: randomUUID(),
          publicId: randomUUID(),
          contentItemId: itemId,
          versionNumber: 1,
          body: dto.body as Prisma.InputJsonValue,
          createdById: actor.internalId,
        },
      });

      // Step 3: link.
      const item = await tx.contentItem.update({ where: { id: itemId }, data: { currentVersionId: version.id }, include: WITH_PUBLIC_REFS });

      // Step 4: audit.
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_CREATED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: item.publicId,
        ipAddress: context.ipAddress,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_VERSION_CREATED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: item.publicId,
        afterState: { versionNumber: 1 },
        ipAddress: context.ipAddress,
      });

      // Step 5: commit — implicit.
      return item;
    });
  }

  // ---------------------------------------------------------------------
  // Read/list — type-aware authorization via ContentPermissionResolver,
  // never a static decorator (Module 1E Engineering Plan §6).
  // ---------------------------------------------------------------------
  async list(
    workspace: { id: string },
    actor: ContentActor,
    filters: { projectId?: string; seriesId?: string; status?: ContentItemStatus; contentType?: string },
  ): Promise<ContentItemWithPublicRefs[]> {
    const viewableTypes = await this.permissions.getViewableContentTypes(actor.publicId, workspace.id);
    if (viewableTypes.length === 0) {
      throw new ForbiddenException({ code: "PERMISSION_DENIED", message: "Missing required permission to view any content type." });
    }
    // An explicitly-requested type outside the caller's viewable set
    // narrows to an empty result set, never an error — enumeration-safe,
    // consistent with the single-item 404 rule below.
    const effectiveTypes = filters.contentType ? viewableTypes.filter((t) => t === filters.contentType) : viewableTypes;

    let projectInternalId: string | undefined;
    if (filters.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: filters.projectId, workspaceId: workspace.id } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectInternalId = project.id;
    }
    let seriesInternalId: string | undefined;
    if (filters.seriesId) {
      const series = await this.prisma.contentSeries.findFirst({ where: { publicId: filters.seriesId, workspaceId: workspace.id, deletedAt: null } });
      if (!series) throw new NotFoundException({ code: "CONTENT_SERIES_NOT_FOUND", message: "Content series not found." });
      seriesInternalId = series.id;
    }

    if (effectiveTypes.length === 0) return [];

    return this.prisma.contentItem.findMany({
      where: {
        workspaceId: workspace.id,
        deletedAt: null,
        contentType: { in: effectiveTypes },
        ...(projectInternalId ? { projectId: projectInternalId } : {}),
        ...(seriesInternalId ? { seriesId: seriesInternalId } : {}),
        ...(filters.status ? { status: filters.status } : {}),
      },
      include: WITH_PUBLIC_REFS,
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Single-item resolution + authorization, shared by every operation
   * below. Enumeration-safe throughout: missing AND unauthorized-by-type
   * both resolve to the identical 404 — a 403 here would itself confirm
   * that a content item of some specific, unauthorized type exists at
   * this id (Module 1E Engineering Plan §6).
   */
  private async resolveForAction(
    workspaceId: string,
    actor: ContentActor,
    itemPublicId: string,
    action: ContentPermissionAction,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, include: WITH_PUBLIC_REFS });
    if (!item) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });

    const allowed = await this.permissions.can(actor.publicId, workspaceId, action, item.contentType);
    if (!allowed) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });

    return item;
  }

  async findOne(workspace: { id: string }, actor: ContentActor, itemPublicId: string): Promise<ContentItemWithPublicRefs> {
    return this.resolveForAction(workspace.id, actor, itemPublicId, "view");
  }

  async update(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: UpdateContentItemDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    const beforeState = { title: item.title };

    const updated = await this.prisma.contentItem.update({
      where: { id: item.id },
      data: {
        title: dto.title ?? undefined,
        metadata: dto.metadata !== undefined ? (dto.metadata as Prisma.InputJsonValue) : undefined,
      },
      include: WITH_PUBLIC_REFS,
    });

    await this.audit.record({
      action: "CONTENT_ITEM_UPDATED",
      actorUserId: actor.internalId,
      workspaceId: workspace.id,
      entityType: "content_item",
      entityId: item.publicId,
      ipAddress: context.ipAddress,
      beforeState,
      afterState: { title: updated.title },
    });

    return updated;
  }

  // ---------------------------------------------------------------------
  // Immutable versioning — an edit always inserts a new version, never
  // mutates one. Only while the item is still in an editable status
  // (DRAFT/IN_PROGRESS) — REVIEW must be rejected back to IN_PROGRESS
  // first, and APPROVED has no revert path in this module's scope.
  // ---------------------------------------------------------------------
  async createVersion(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: CreateContentVersionDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    // item.contentType is guaranteed supported — create() gates it and
    // nothing in this module ever produces an unsupported-type row.
    this.bodyValidator.validate(item.contentType as "BLOG" | "VIDEO", dto.body);

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (!EDITABLE_STATUSES.includes(locked.status)) {
        throw new ConflictException({ code: "CONTENT_ITEM_NOT_EDITABLE", message: `Cannot add a new version while status is ${locked.status}.` });
      }

      const latest = await tx.contentVersion.findFirst({ where: { contentItemId: locked.id }, orderBy: { versionNumber: "desc" } });
      const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

      const version = await tx.contentVersion.create({
        data: {
          id: randomUUID(),
          publicId: randomUUID(),
          contentItemId: locked.id,
          versionNumber: nextVersionNumber,
          body: dto.body as Prisma.InputJsonValue,
          createdById: actor.internalId,
        },
      });
      const updated = await tx.contentItem.update({ where: { id: locked.id }, data: { currentVersionId: version.id }, include: WITH_PUBLIC_REFS });

      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_VERSION_CREATED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        afterState: { versionNumber: nextVersionNumber },
        ipAddress: context.ipAddress,
      });

      return updated;
    });
  }

  // ---------------------------------------------------------------------
  // Editorial lifecycle transitions.
  // ---------------------------------------------------------------------
  async start(workspace: { id: string }, actor: ContentActor, itemPublicId: string, context: RequestContext): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (locked.status !== "DRAFT") {
        throw new ConflictException({ code: "CONTENT_ITEM_INVALID_TRANSITION", message: `Cannot start from status ${locked.status}.` });
      }
      const updated = await tx.contentItem.update({ where: { id: locked.id }, data: { status: "IN_PROGRESS" }, include: WITH_PUBLIC_REFS });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_STARTED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async submitForReview(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: SubmitForReviewDto,
    context: RequestContext,
    // Module 6 Phase 6.3 review-gate seal: this shared lifecycle service
    // stays the single authority for the REVIEW transition, but a BLOG
    // content item may ONLY enter REVIEW through the Blog pipeline
    // (BlogService, which enforces the frozen FR-BLOG-001..006 Quality
    // Gates, incl. the FR-BLOG-006 score threshold, before calling here).
    // The generic public route never sets this flag, so it cannot be used
    // to bypass those gates. Not part of any DTO — it can never be set
    // from an HTTP request.
    options?: { viaBlogPipeline?: boolean },
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    if (item.contentType === "BLOG" && !options?.viaBlogPipeline) {
      throw new ConflictException({
        code: "CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE",
        message:
          "A blog article must be submitted for review through the Blog pipeline (POST /api/v1/workspaces/:workspaceId/blog/:itemId/submit-for-review), which enforces the Module 6 quality gates.",
      });
    }
    const comment = this.validateAndNormalizeComment(dto.comment, { required: false });

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (locked.status !== "IN_PROGRESS") {
        throw new ConflictException({ code: "CONTENT_ITEM_INVALID_TRANSITION", message: `Cannot submit for review from status ${locked.status}.` });
      }
      if (!locked.currentVersionId) {
        // Unreachable given the deferred trigger, kept as a defensive
        // guard rather than a silent null-write to content_review_events.
        throw new ConflictException({ code: "CONTENT_ITEM_HAS_NO_VERSION", message: "Content item has no current version." });
      }

      const updated = await tx.contentItem.update({ where: { id: locked.id }, data: { status: "REVIEW" }, include: WITH_PUBLIC_REFS });
      await this.createReviewEvent(tx, {
        workspaceId: workspace.id,
        contentItemId: locked.id,
        contentVersionId: locked.currentVersionId,
        action: "SUBMITTED",
        comment,
        actorId: actor.internalId,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_SUBMITTED_FOR_REVIEW",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async approve(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: ApproveContentDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "approve");
    const comment = this.validateAndNormalizeComment(dto.comment, { required: false });

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (locked.status !== "REVIEW") {
        throw new ConflictException({ code: "CONTENT_ITEM_INVALID_TRANSITION", message: `Cannot approve from status ${locked.status}.` });
      }
      if (!locked.currentVersionId) {
        throw new ConflictException({ code: "CONTENT_ITEM_HAS_NO_VERSION", message: "Content item has no current version." });
      }

      const updated = await tx.contentItem.update({ where: { id: locked.id }, data: { status: "APPROVED" }, include: WITH_PUBLIC_REFS });
      await this.createReviewEvent(tx, {
        workspaceId: workspace.id,
        contentItemId: locked.id,
        contentVersionId: locked.currentVersionId,
        action: "APPROVED",
        comment,
        actorId: actor.internalId,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_APPROVED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async reject(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: RejectContentDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "approve");
    const comment = this.validateAndNormalizeComment(dto.comment, { required: true });

    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (locked.status !== "REVIEW") {
        throw new ConflictException({ code: "CONTENT_ITEM_INVALID_TRANSITION", message: `Cannot reject from status ${locked.status}.` });
      }
      if (!locked.currentVersionId) {
        throw new ConflictException({ code: "CONTENT_ITEM_HAS_NO_VERSION", message: "Content item has no current version." });
      }

      const updated = await tx.contentItem.update({ where: { id: locked.id }, data: { status: "IN_PROGRESS" }, include: WITH_PUBLIC_REFS });
      await this.createReviewEvent(tx, {
        workspaceId: workspace.id,
        contentItemId: locked.id,
        contentVersionId: locked.currentVersionId,
        action: "REJECTED",
        comment,
        actorId: actor.internalId,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_REJECTED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async archive(workspace: { id: string }, actor: ContentActor, itemPublicId: string, context: RequestContext): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (!ARCHIVABLE_STATUSES.includes(locked.status)) {
        throw new ConflictException({ code: "CONTENT_ITEM_NOT_ARCHIVABLE", message: `Cannot archive from status ${locked.status}.` });
      }
      const updated = await tx.contentItem.update({
        where: { id: locked.id },
        data: { status: "ARCHIVED", archivedFromStatus: locked.status, archivedAt: new Date() },
        include: WITH_PUBLIC_REFS,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_ARCHIVED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        beforeState: { status: locked.status },
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async restore(workspace: { id: string }, actor: ContentActor, itemPublicId: string, context: RequestContext): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    return this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      if (locked.status !== "ARCHIVED" || !locked.archivedFromStatus) {
        throw new ConflictException({ code: "CONTENT_ITEM_NOT_ARCHIVED", message: "Content item is not archived." });
      }
      const updated = await tx.contentItem.update({
        where: { id: locked.id },
        data: { status: locked.archivedFromStatus, archivedFromStatus: null, archivedAt: null },
        include: WITH_PUBLIC_REFS,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_RESTORED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        afterState: { status: locked.archivedFromStatus },
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  async remove(workspace: { id: string }, actor: ContentActor, itemPublicId: string, context: RequestContext): Promise<void> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");
    await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItemOrThrow(tx, item.id);
      await tx.contentItem.update({ where: { id: locked.id }, data: { status: "DELETED", deletedAt: new Date() } });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_DELETED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: locked.publicId,
        ipAddress: context.ipAddress,
      });
    });
  }

  /**
   * Shared by submit/approve/reject — the single place a review comment's
   * length is checked against the *configured* limit. Previously only
   * reject() re-validated against ConfigService (submit/approve trimmed
   * and passed the comment straight through); an operator lowering
   * CONTENT_REVIEW_COMMENT_MAX_LENGTH below the DTO layer's hardcoded
   * 2000-char ceiling would have had that stricter limit silently
   * unenforced for submit/approve. required=true additionally rejects a
   * blank/whitespace-only comment (reject's own rule).
   */
  private validateAndNormalizeComment(comment: string | undefined, options: { required: boolean }): string | null {
    const maxLength = this.config.get("content", { infer: true }).reviewCommentMaxLength;
    const trimmed = comment?.trim() ?? "";
    if (options.required && trimmed.length === 0) {
      throw new BadRequestException({ code: "CONTENT_REVIEW_COMMENT_REQUIRED", message: "A non-empty comment is required to reject content." });
    }
    if (trimmed.length > maxLength) {
      throw new BadRequestException({ code: "CONTENT_REVIEW_COMMENT_TOO_LONG", message: `comment must be at most ${maxLength} characters.` });
    }
    return trimmed.length === 0 ? null : trimmed;
  }

  // ---------------------------------------------------------------------
  // Series assignment/reassignment/unassignment — Module 1E Engineering
  // Plan's final correction round, "Serialize Series Assignment and
  // Deletion" + mandatory global lock order: Content Series row(s) by id
  // ASCENDING, THEN the Content Item row, never the reverse. Locks BOTH
  // the old and new series (when reassigning) specifically so a
  // concurrent deletion of the OLD series (ContentSeriesService.remove,
  // which locks only that one row) always serializes against this
  // transaction rather than racing it.
  // ---------------------------------------------------------------------
  async assignSeries(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: UpdateContentItemSeriesDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");

    let targetSeriesInternalId: string | null = null;
    if (dto.seriesId !== null) {
      const target = await this.prisma.contentSeries.findFirst({ where: { publicId: dto.seriesId, workspaceId: workspace.id, deletedAt: null } });
      if (!target) throw new NotFoundException({ code: "CONTENT_SERIES_NOT_FOUND", message: "Content series not found." });
      targetSeriesInternalId = target.id;
    }

    const seriesIdsToLock = Array.from(new Set([item.seriesId, targetSeriesInternalId].filter((id): id is string => id !== null))).sort();

    return this.prisma.$transaction(async (tx) => {
      const lockedSeries =
        seriesIdsToLock.length > 0
          ? await tx.$queryRaw<LockedSeriesRow[]>`
              SELECT ${Prisma.raw(CONTENT_SERIES_LOCK_COLUMNS)} FROM content_series WHERE id = ANY(${seriesIdsToLock}::uuid[]) ORDER BY id ASC FOR UPDATE
            `
          : [];

      const lockedItem = await this.lockItemOrThrow(tx, item.id);

      // A third party changed this item's series between our pre-
      // transaction lookup and lock acquisition — the lock set above may
      // no longer be the right one. Abort deterministically rather than
      // risk validating compatibility against a series we never locked.
      if (lockedItem.seriesId !== item.seriesId) {
        throw new ConflictException({ code: "CONTENT_ITEM_SERIES_STATE_CHANGED", message: "This item's series assignment changed concurrently. Retry." });
      }

      let targetSeries: LockedSeriesRow | undefined;
      if (targetSeriesInternalId !== null) {
        targetSeries = lockedSeries.find((s) => s.id === targetSeriesInternalId);
        if (!targetSeries || targetSeries.deletedAt) {
          throw new NotFoundException({ code: "CONTENT_SERIES_NOT_FOUND", message: "Content series not found." });
        }
        if (!isSeriesProjectCompatible(targetSeries.projectId, lockedItem.projectId)) {
          throw new ConflictException({
            code: "CONTENT_ITEM_SERIES_PROJECT_INCOMPATIBLE",
            message: "This content item's project is not compatible with the target series.",
          });
        }
      }

      const updated = await tx.contentItem.update({ where: { id: lockedItem.id }, data: { seriesId: targetSeriesInternalId }, include: WITH_PUBLIC_REFS });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_SERIES_CHANGED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: lockedItem.publicId,
        beforeState: { seriesId: lockedItem.seriesId },
        afterState: { seriesId: targetSeriesInternalId },
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }

  // ---------------------------------------------------------------------
  // Project reassignment — the plan's exact 8-step sequence: pre-resolve
  // item + current series -> lock current series first -> lock item
  // second -> revalidate -> validate compatibility -> update -> audit ->
  // commit. Same series-before-item ordering as assignSeries, and the
  // same "did the pre-transaction snapshot go stale" safeguard.
  // ---------------------------------------------------------------------
  async updateProject(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: UpdateContentItemProjectDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    // Step 1: pre-resolve item + current series.
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");

    let targetProjectInternalId: string | null = null;
    if (dto.projectId !== null) {
      const project = await this.prisma.project.findFirst({ where: { publicId: dto.projectId, workspaceId: workspace.id, deletedAt: null } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      targetProjectInternalId = project.id;
    }

    return this.prisma.$transaction(async (tx) => {
      // Step 2: lock current series first (if any) — single row, no
      // ORDER BY needed since project-change never involves a second
      // series the way reassignment does.
      let lockedCurrentSeries: LockedSeriesRow | undefined;
      if (item.seriesId) {
        const [locked] = await tx.$queryRaw<LockedSeriesRow[]>`
          SELECT ${Prisma.raw(CONTENT_SERIES_LOCK_COLUMNS)} FROM content_series WHERE id = ${item.seriesId}::uuid FOR UPDATE
        `;
        lockedCurrentSeries = locked;
      }

      // Step 3: lock item second.
      const lockedItem = await this.lockItemOrThrow(tx, item.id);

      // Step 4: revalidate — the series lock acquired above is only
      // trustworthy if the item's series assignment hasn't changed since
      // the pre-transaction snapshot.
      if (lockedItem.seriesId !== item.seriesId) {
        throw new ConflictException({ code: "CONTENT_ITEM_SERIES_STATE_CHANGED", message: "This item's series assignment changed concurrently. Retry." });
      }

      // Step 5: validate compatibility — only relevant if the item
      // currently has a series; a project-specific series would no
      // longer accept the item under its new project.
      if (lockedCurrentSeries && !lockedCurrentSeries.deletedAt) {
        if (!isSeriesProjectCompatible(lockedCurrentSeries.projectId, targetProjectInternalId)) {
          throw new ConflictException({
            code: "CONTENT_ITEM_SERIES_PROJECT_INCOMPATIBLE",
            message: "This content item's current series is not compatible with the target project. Unassign the series first.",
          });
        }
      }

      // Step 6: update.
      const updated = await tx.contentItem.update({
        where: { id: lockedItem.id },
        data: { projectId: targetProjectInternalId },
        include: WITH_PUBLIC_REFS,
      });

      // Step 7: audit.
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_UPDATED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: lockedItem.publicId,
        beforeState: { projectId: lockedItem.projectId },
        afterState: { projectId: targetProjectInternalId },
        ipAddress: context.ipAddress,
      });

      // Step 8: commit — implicit.
      return updated;
    });
  }

  // ---------------------------------------------------------------------
  // Featured media — "own item or unassigned only" (Module 1E Engineering
  // Plan's Featured Media Semantics). A fixed, always-consistent lock
  // order between the two resource types this touches: content_items row
  // is always locked before media_assets row, one level below the
  // series-before-item order above — never the reverse, anywhere in this
  // module.
  // ---------------------------------------------------------------------
  async setFeaturedMedia(
    workspace: { id: string },
    actor: ContentActor,
    itemPublicId: string,
    dto: UpdateContentItemFeaturedMediaDto,
    context: RequestContext,
  ): Promise<ContentItemWithPublicRefs> {
    const item = await this.resolveForAction(workspace.id, actor, itemPublicId, "edit");

    if (dto.mediaAssetId === null) {
      return this.prisma.$transaction(async (tx) => {
        const lockedItem = await this.lockItemOrThrow(tx, item.id);
        const updated = await tx.contentItem.update({ where: { id: lockedItem.id }, data: { featuredMediaAssetId: null }, include: WITH_PUBLIC_REFS });
        await this.audit.recordWithinTransaction(tx, {
          action: "CONTENT_ITEM_UPDATED",
          actorUserId: actor.internalId,
          workspaceId: workspace.id,
          entityType: "content_item",
          entityId: lockedItem.publicId,
          beforeState: { featuredMediaAssetId: lockedItem.featuredMediaAssetId },
          afterState: { featuredMediaAssetId: null },
          ipAddress: context.ipAddress,
        });
        return updated;
      });
    }

    const mediaLookup = await this.prisma.mediaAsset.findFirst({ where: { publicId: dto.mediaAssetId, workspaceId: workspace.id } });
    if (!mediaLookup) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });

    return this.prisma.$transaction(async (tx) => {
      // content_items before media_assets — fixed order.
      const lockedItem = await this.lockItemOrThrow(tx, item.id);

      const [lockedMedia] = await tx.$queryRaw<LockedMediaAssetRow[]>`
        SELECT ${Prisma.raw(MEDIA_ASSET_LOCK_COLUMNS)} FROM media_assets WHERE id = ${mediaLookup.id}::uuid FOR UPDATE
      `;
      if (!lockedMedia) throw new NotFoundException({ code: "MEDIA_ASSET_NOT_FOUND", message: "Media asset not found." });
      if (lockedMedia.status !== "ACTIVE") {
        throw new ConflictException({ code: "MEDIA_ASSET_NOT_ACTIVE", message: "Only an ACTIVE asset can be set as featured media." });
      }
      if (lockedMedia.contentItemId !== null && lockedMedia.contentItemId !== lockedItem.id) {
        throw new ConflictException({ code: "MEDIA_ASSET_ALREADY_ATTACHED", message: "This media asset is already attached to a different content item." });
      }

      if (lockedMedia.contentItemId === null) {
        // Completes the Module 1D-created media_assets.content_item_id
        // column from the 1E side — 1D's own files are never touched
        // (frozen; see MODULE 1D freeze directive).
        await tx.mediaAsset.update({ where: { id: lockedMedia.id }, data: { contentItemId: lockedItem.id } });
      }

      const updated = await tx.contentItem.update({
        where: { id: lockedItem.id },
        data: { featuredMediaAssetId: lockedMedia.id },
        include: WITH_PUBLIC_REFS,
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_ITEM_UPDATED",
        actorUserId: actor.internalId,
        workspaceId: workspace.id,
        entityType: "content_item",
        entityId: lockedItem.publicId,
        beforeState: { featuredMediaAssetId: lockedItem.featuredMediaAssetId },
        afterState: { featuredMediaAssetId: mediaLookup.publicId },
        ipAddress: context.ipAddress,
      });
      return updated;
    });
  }
}
