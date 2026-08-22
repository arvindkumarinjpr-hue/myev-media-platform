import { randomUUID } from "crypto";
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { Prisma as PrismaNS, type KnowledgePack, type Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { CreateKnowledgePackDto } from "./dto/create-knowledge-pack.dto";
import { KNOWLEDGE_PACK_CONTENT_TYPES } from "./dto/knowledge-pack-child.dto";
import type { UpdateKnowledgePackDto } from "./dto/update-knowledge-pack.dto";

interface RequestContext {
  ipAddress?: string;
}

const KNOWLEDGE_PACK_INCLUDE = {
  knowledgeSources: true,
  promptTemplates: true,
  seoRules: true,
  brandGuidelines: true,
  keywordSets: true,
  competitors: true,
} satisfies Prisma.KnowledgePackInclude;

export type KnowledgePackWithChildren = Prisma.KnowledgePackGetPayload<{ include: typeof KNOWLEDGE_PACK_INCLUDE }>;

@Injectable()
export class KnowledgePacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Phase 2.2 scope only — Draft-only CRUD, per
   * MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §17. No validate/
   * activate/archive/versioning here (Phase 2.3+) — every operation
   * below either creates a Draft or mutates one already in that state.
   */
  async create(workspaceId: string, actorUserId: string, dto: CreateKnowledgePackDto, context: RequestContext): Promise<KnowledgePackWithChildren> {
    return this.prisma.$transaction(async (tx) => {
      let projectInternalId: string | null = null;
      if (dto.projectId) {
        const project = await tx.project.findFirst({ where: { publicId: dto.projectId, workspaceId, deletedAt: null }, select: { id: true } });
        if (!project) {
          throw new UnprocessableEntityException({ code: "KNOWLEDGE_VALIDATION_FAILED", message: "projectId does not reference a project in this workspace.", details: ["projectId"] });
        }
        projectInternalId = project.id;
      }

      // Root version of a lineage: id and lineage_root_id are the same
      // value (ADR-014) — generated up front so both columns can be set
      // in one INSERT.
      const id = randomUUID();
      const pack = await tx.knowledgePack.create({
        data: {
          id,
          workspaceId,
          projectId: projectInternalId,
          name: dto.name,
          industryProfile: (dto.industryProfile ?? {}) as Prisma.InputJsonValue,
          publishingStrategy: (dto.publishingStrategy ?? {}) as Prisma.InputJsonValue,
          lineageRootId: id,
          status: "DRAFT",
          createdById: actorUserId,
        },
        include: KNOWLEDGE_PACK_INCLUDE,
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "KNOWLEDGE_PACK_CREATED",
        actorUserId,
        workspaceId,
        entityType: "knowledge_pack",
        entityId: pack.publicId,
        ipAddress: context.ipAddress,
      });

      return pack;
    });
  }

  async list(workspaceId: string, filters: { projectId?: string } = {}): Promise<KnowledgePack[]> {
    let projectInternalId: string | undefined;
    if (filters.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: filters.projectId, workspaceId, deletedAt: null }, select: { id: true } });
      // An unresolvable filter yields an empty list, not an error — same
      // convention as every other workspace-scoped list endpoint's
      // optional filter in this codebase.
      projectInternalId = project?.id ?? "00000000-0000-0000-0000-000000000000";
    }
    return this.prisma.knowledgePack.findMany({
      where: { workspaceId, deletedAt: null, ...(projectInternalId ? { projectId: projectInternalId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  async findOne(workspaceId: string, publicId: string): Promise<KnowledgePackWithChildren> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, publicId, deletedAt: null },
      include: KNOWLEDGE_PACK_INCLUDE,
    });
    if (!pack) {
      // Cross-workspace / non-existent probe — enumeration-safe, same
      // rule ProjectsService.findOne and WorkspaceContextGuard already
      // establish.
      throw new NotFoundException({ code: "KNOWLEDGE_NOT_FOUND", message: "Knowledge Pack not found." });
    }
    return pack;
  }

  async update(
    workspaceId: string,
    publicId: string,
    actorUserId: string,
    dto: UpdateKnowledgePackDto,
    context: RequestContext,
  ): Promise<KnowledgePackWithChildren> {
    const existing = await this.findOne(workspaceId, publicId);
    if (existing.status !== "DRAFT") {
      throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Only a Draft Knowledge Pack version may be edited in place." });
    }

    let resolvedLogoAssetId: string | null | undefined;
    if (dto.brandGuidelines?.some((bg) => bg.logoAssetId)) {
      // Only ever one brand-guideline row is meaningful per pack version
      // in V1 (Database Design §5.3 doesn't multiply this concept) — the
      // first supplied logoAssetId, if any, is resolved the same
      // public-id-to-internal-id way as projectId (ADR-013).
      const requested = dto.brandGuidelines.find((bg) => bg.logoAssetId)?.logoAssetId;
      if (requested) {
        const asset = await this.prisma.mediaAsset.findFirst({ where: { publicId: requested, workspaceId, deletedAt: null }, select: { id: true } });
        if (!asset) {
          throw new UnprocessableEntityException({ code: "KNOWLEDGE_VALIDATION_FAILED", message: "logoAssetId does not reference a media asset in this workspace.", details: ["brandGuidelines.logoAssetId"] });
        }
        resolvedLogoAssetId = asset.id;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const guarded = await tx.knowledgePack.updateMany({
        where: { id: existing.id, lockVersion: dto.expectedLockVersion },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.industryProfile !== undefined ? { industryProfile: dto.industryProfile as Prisma.InputJsonValue } : {}),
          ...(dto.publishingStrategy !== undefined ? { publishingStrategy: dto.publishingStrategy as Prisma.InputJsonValue } : {}),
          updatedById: actorUserId,
          lockVersion: { increment: 1 },
        },
      });
      if (guarded.count === 0) {
        // Existence was already confirmed above — a zero-row guarded
        // update here can only mean the caller's expectedLockVersion is
        // stale (ADR-014 §6/§10), never "not found".
        throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Knowledge Pack was modified since it was last read — refresh and retry." });
      }

      await this.replaceChildCollections(tx, existing.id, dto, resolvedLogoAssetId);

      await this.audit.recordWithinTransaction(tx, {
        action: "KNOWLEDGE_PACK_UPDATED",
        actorUserId,
        workspaceId,
        entityType: "knowledge_pack",
        entityId: existing.publicId,
        ipAddress: context.ipAddress,
      });

      return tx.knowledgePack.findUniqueOrThrow({ where: { id: existing.id }, include: KNOWLEDGE_PACK_INCLUDE });
    });
  }

  /** Draft-only soft delete (§12 of the architecture record) — never a non-Draft version, never a hard delete. */
  async remove(workspaceId: string, publicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const existing = await this.findOne(workspaceId, publicId);
    if (existing.status !== "DRAFT") {
      throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Only a Draft Knowledge Pack version may be deleted; Active/Archived versions must be archived instead." });
    }
    await this.prisma.knowledgePack.update({ where: { id: existing.id }, data: { deletedAt: new Date(), updatedById: actorUserId } });
    await this.audit.record({
      action: "KNOWLEDGE_PACK_DELETED",
      actorUserId,
      workspaceId,
      entityType: "knowledge_pack",
      entityId: existing.publicId,
      ipAddress: context.ipAddress,
    });
  }

  /**
   * Phase 2.3 — Validation + Activation, first-version (root) only. A Draft
   * with `currentVersionOfId` set is a successor awaiting the Phase 2.4
   * supersession workflow (cloning, predecessor archival, the RESTRICT
   * check on the predecessor) — that machinery does not exist yet, so this
   * method explicitly refuses to touch such a Draft rather than fake any
   * part of that behavior. See MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md
   * §7 and §17.
   */
  async validate(workspaceId: string, publicId: string, actorUserId: string, context: RequestContext): Promise<KnowledgePackWithChildren> {
    const existing = await this.findOne(workspaceId, publicId);

    if (existing.currentVersionOfId !== null) {
      throw new ConflictException({
        code: "KNOWLEDGE_CONFLICT",
        message: "This Knowledge Pack is a successor version; activation of successor versions is not available until Phase 2.4 (version supersession).",
      });
    }

    // A rejection (failed gates) must still durably commit its DRAFT
    // revert and its audit record — but Prisma's interactive $transaction
    // treats ANY thrown error inside the callback as a rollback signal, so
    // that outcome is returned as data here and only turned into a thrown
    // exception once the transaction has actually committed, below.
    type Outcome = { kind: "rejected"; failures: string[] } | { kind: "activated"; pack: KnowledgePackWithChildren };

    const outcome = await this.prisma.$transaction(async (tx): Promise<Outcome> => {
      const toValidating = await tx.knowledgePack.updateMany({
        where: { id: existing.id, status: "DRAFT" },
        data: { status: "VALIDATING" },
      });
      if (toValidating.count === 0) {
        // Existence and successor-status were already confirmed above — a
        // zero-row guarded update here can only mean a concurrent caller
        // already moved this Draft out of DRAFT (another validate() call in
        // flight, or an edit raced this one). Nothing was written in this
        // transaction attempt, so rollback-via-throw is correct here.
        throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Only a Draft Knowledge Pack version may be validated." });
      }

      const pack = await tx.knowledgePack.findUniqueOrThrow({ where: { id: existing.id }, include: KNOWLEDGE_PACK_INCLUDE });
      const failures = this.runValidationGates(pack);

      if (failures.length > 0) {
        await tx.knowledgePack.updateMany({ where: { id: existing.id, status: "VALIDATING" }, data: { status: "DRAFT" } });
        await this.audit.recordWithinTransaction(tx, {
          action: "KNOWLEDGE_PACK_VALIDATION_REJECTED",
          actorUserId,
          workspaceId,
          entityType: "knowledge_pack",
          entityId: existing.publicId,
          ipAddress: context.ipAddress,
          afterState: { status: "DRAFT", failures },
        });
        return { kind: "rejected", failures };
      }

      try {
        const toActive = await tx.knowledgePack.updateMany({ where: { id: existing.id, status: "VALIDATING" }, data: { status: "ACTIVE" } });
        if (toActive.count === 0) {
          throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Knowledge Pack state changed unexpectedly during activation." });
        }
      } catch (err) {
        if (err instanceof PrismaNS.PrismaClientKnownRequestError && err.code === "P2002") {
          // knowledge_packs_one_active_per_lineage — another Active version
          // already exists for this lineage. Unreachable via today's API
          // (Phase 2.3 only ever activates a pack that is its own lineage
          // root), but the DB invariant is the final backstop regardless of
          // how a row's lineage_root_id came to collide with an existing
          // Active row's. Rolling back (rethrow) leaves the Draft untouched.
          throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Another Active version already exists for this Knowledge Pack lineage." });
        }
        throw err;
      }

      await this.audit.recordWithinTransaction(tx, {
        action: "KNOWLEDGE_PACK_ACTIVATED",
        actorUserId,
        workspaceId,
        entityType: "knowledge_pack",
        entityId: existing.publicId,
        ipAddress: context.ipAddress,
        beforeState: { status: "DRAFT" },
        afterState: { status: "ACTIVE" },
      });

      return { kind: "activated", pack: await tx.knowledgePack.findUniqueOrThrow({ where: { id: existing.id }, include: KNOWLEDGE_PACK_INCLUDE }) };
    });

    if (outcome.kind === "rejected") {
      throw new UnprocessableEntityException({ code: "KNOWLEDGE_VALIDATION_FAILED", message: "Knowledge Pack failed activation validation.", details: outcome.failures });
    }
    return outcome.pack;
  }

  /** The 4 FR-KP-005 gates. No Project-reference RESTRICT check here — that only guards a predecessor being superseded (Phase 2.4/2.5), and Phase 2.3 never has one. */
  private runValidationGates(pack: KnowledgePackWithChildren): string[] {
    const failures: string[] = [];

    if (pack.knowledgeSources.length === 0) {
      failures.push("At least one trusted knowledge source is required (FR-KP-002).");
    }

    const missingContentTypes = KNOWLEDGE_PACK_CONTENT_TYPES.filter(
      (contentType) => !pack.promptTemplates.some((template) => template.contentType === contentType),
    );
    if (missingContentTypes.length > 0) {
      failures.push(`At least one prompt template is required for every content type; missing: ${missingContentTypes.join(", ")} (FR-KP-003).`);
    }

    const industryProfile = pack.industryProfile as Prisma.JsonObject | null;
    if (!pack.name || pack.name.trim().length === 0 || !industryProfile || Object.keys(industryProfile).length === 0) {
      failures.push("Brand name and a populated industry profile are required (FR-KP-001).");
    }

    const publishingStrategy = pack.publishingStrategy as Prisma.JsonObject | null;
    if (!publishingStrategy || Object.keys(publishingStrategy).length === 0) {
      failures.push("A publishing strategy is required (FR-KP-004).");
    }

    return failures;
  }

  /** Any collection present in `dto` wholesale-replaces the pack's current rows of that type — never a partial merge. */
  private async replaceChildCollections(
    tx: Prisma.TransactionClient,
    knowledgePackId: string,
    dto: UpdateKnowledgePackDto,
    resolvedLogoAssetId: string | null | undefined,
  ): Promise<void> {
    if (dto.sources) {
      await tx.knowledgeSource.deleteMany({ where: { knowledgePackId } });
      if (dto.sources.length > 0) {
        await tx.knowledgeSource.createMany({ data: dto.sources.map((s) => ({ knowledgePackId, sourceType: s.sourceType, url: s.url })) });
      }
    }
    if (dto.promptTemplates) {
      await tx.promptTemplate.deleteMany({ where: { knowledgePackId } });
      if (dto.promptTemplates.length > 0) {
        await tx.promptTemplate.createMany({ data: dto.promptTemplates.map((p) => ({ knowledgePackId, contentType: p.contentType, promptBody: p.promptBody })) });
      }
    }
    if (dto.seoRules) {
      await tx.knowledgePackSeoRule.deleteMany({ where: { knowledgePackId } });
      if (dto.seoRules.length > 0) {
        await tx.knowledgePackSeoRule.createMany({
          data: dto.seoRules.map((r) => ({
            knowledgePackId,
            primaryKeywords: (r.primaryKeywords ?? []) as Prisma.InputJsonValue,
            secondaryKeywords: (r.secondaryKeywords ?? []) as Prisma.InputJsonValue,
            internalLinkingPolicy: (r.internalLinkingPolicy ?? {}) as Prisma.InputJsonValue,
            schemaPreferences: (r.schemaPreferences ?? {}) as Prisma.InputJsonValue,
          })),
        });
      }
    }
    if (dto.brandGuidelines) {
      await tx.brandGuideline.deleteMany({ where: { knowledgePackId } });
      if (dto.brandGuidelines.length > 0) {
        await tx.brandGuideline.createMany({
          data: dto.brandGuidelines.map((b) => ({
            knowledgePackId,
            toneOfVoice: b.toneOfVoice,
            terminology: (b.terminology ?? {}) as Prisma.InputJsonValue,
            ctaRules: b.ctaRules,
            logoAssetId: b.logoAssetId ? resolvedLogoAssetId : null,
          })),
        });
      }
    }
    if (dto.keywordSets) {
      await tx.keywordSet.deleteMany({ where: { knowledgePackId } });
      if (dto.keywordSets.length > 0) {
        await tx.keywordSet.createMany({ data: dto.keywordSets.map((k) => ({ knowledgePackId, name: k.name, keywords: k.keywords as Prisma.InputJsonValue })) });
      }
    }
    if (dto.competitors) {
      await tx.competitor.deleteMany({ where: { knowledgePackId } });
      if (dto.competitors.length > 0) {
        await tx.competitor.createMany({ data: dto.competitors.map((c) => ({ knowledgePackId, domain: c.domain, notes: c.notes })) });
      }
    }
  }
}
