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
   * Phase 2.5 §8/§12 — explicit archive. Only from ACTIVE (the lifecycle
   * diagram, §6, has no other legal inbound edge to ARCHIVED besides this
   * and supersession's own bundled archival). Same RESTRICT rule as
   * supersession's gate 5 — no automatic Project reassignment, ever. A
   * blocked attempt changes nothing, so unlike validate()'s gate failures
   * it is a plain rejection, not an audited outcome (§16 calls out
   * "validate (both outcomes, including the RESTRICT-blocked outcome)"
   * specifically; it does not extend that same exception to archive).
   */
  async archive(workspaceId: string, publicId: string, actorUserId: string, context: RequestContext): Promise<KnowledgePackWithChildren> {
    const existing = await this.findOne(workspaceId, publicId);
    if (existing.status !== "ACTIVE") {
      throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Only an Active Knowledge Pack version may be archived." });
    }

    return this.prisma.$transaction(async (tx) => {
      // Checked inside the same transaction as the guarded update below —
      // not before it — so nothing can reassign a Project onto this
      // version between the check and the write.
      const restrictingProjectCount = await tx.project.count({ where: { knowledgePackId: existing.id, deletedAt: null } });
      if (restrictingProjectCount > 0) {
        throw new ConflictException({
          code: "KNOWLEDGE_CONFLICT",
          message: `Blocked by ${restrictingProjectCount} Project(s) still referencing this version; reassign them before it can be archived (Owner Decision 7, RESTRICT).`,
        });
      }

      const guarded = await tx.knowledgePack.updateMany({ where: { id: existing.id, status: "ACTIVE" }, data: { status: "ARCHIVED", archivedAt: new Date() } });
      if (guarded.count === 0) {
        throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Knowledge Pack state changed unexpectedly — retry." });
      }

      await this.audit.recordWithinTransaction(tx, {
        action: "KNOWLEDGE_PACK_ARCHIVED",
        actorUserId,
        workspaceId,
        entityType: "knowledge_pack",
        entityId: existing.publicId,
        ipAddress: context.ipAddress,
        beforeState: { status: "ACTIVE" },
        afterState: { status: "ARCHIVED" },
      });

      return tx.knowledgePack.findUniqueOrThrow({ where: { id: existing.id }, include: KNOWLEDGE_PACK_INCLUDE });
    });
  }

  /**
   * Phase 2.4 §9 — creates a new Draft version by cloning the complete
   * current configuration of an Active predecessor: both root JSONB
   * columns and all 6 child tables, each cloned child receiving its own
   * new row identity, never shared with the predecessor. The predecessor
   * itself is never mutated by this call — it stays ACTIVE and immutable.
   * This is the sole supported path from Active content to a new editable
   * snapshot (Phase 2.2's update() already rejects non-Draft edits).
   *
   * `knowledge_packs_one_successor_per_predecessor` (this phase's new
   * partial unique index) is the concurrency backstop: two concurrent
   * calls racing to version the same predecessor can only ever produce one
   * successor, never two divergent ones with colliding version_numbers.
   */
  async createVersion(workspaceId: string, publicId: string, actorUserId: string, context: RequestContext): Promise<KnowledgePackWithChildren> {
    const existing = await this.findOne(workspaceId, publicId);
    if (existing.status !== "ACTIVE") {
      throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "A new version can only be created from an Active Knowledge Pack." });
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const newId = randomUUID();
        const v2 = await tx.knowledgePack.create({
          data: {
            id: newId,
            workspaceId,
            projectId: existing.projectId,
            name: existing.name,
            industryProfile: existing.industryProfile as Prisma.InputJsonValue,
            publishingStrategy: existing.publishingStrategy as Prisma.InputJsonValue,
            versionNumber: existing.versionNumber + 1,
            currentVersionOfId: existing.id,
            lineageRootId: existing.lineageRootId,
            status: "DRAFT",
            createdById: actorUserId,
          },
        });

        if (existing.knowledgeSources.length > 0) {
          await tx.knowledgeSource.createMany({
            data: existing.knowledgeSources.map((s) => ({ knowledgePackId: newId, sourceType: s.sourceType, url: s.url })),
          });
        }
        if (existing.promptTemplates.length > 0) {
          // Template revisions carry forward as-is (§6 two-layer model) —
          // cloning is not itself a template edit.
          await tx.promptTemplate.createMany({
            data: existing.promptTemplates.map((p) => ({ knowledgePackId: newId, contentType: p.contentType, promptBody: p.promptBody, versionNumber: p.versionNumber })),
          });
        }
        if (existing.seoRules.length > 0) {
          await tx.knowledgePackSeoRule.createMany({
            data: existing.seoRules.map((r) => ({
              knowledgePackId: newId,
              primaryKeywords: r.primaryKeywords as Prisma.InputJsonValue,
              secondaryKeywords: r.secondaryKeywords as Prisma.InputJsonValue,
              internalLinkingPolicy: r.internalLinkingPolicy as Prisma.InputJsonValue,
              schemaPreferences: r.schemaPreferences as Prisma.InputJsonValue,
            })),
          });
        }
        if (existing.brandGuidelines.length > 0) {
          await tx.brandGuideline.createMany({
            data: existing.brandGuidelines.map((b) => ({
              knowledgePackId: newId,
              toneOfVoice: b.toneOfVoice,
              terminology: b.terminology as Prisma.InputJsonValue,
              ctaRules: b.ctaRules,
              logoAssetId: b.logoAssetId,
            })),
          });
        }
        if (existing.keywordSets.length > 0) {
          await tx.keywordSet.createMany({
            data: existing.keywordSets.map((k) => ({ knowledgePackId: newId, name: k.name, keywords: k.keywords as Prisma.InputJsonValue })),
          });
        }
        if (existing.competitors.length > 0) {
          await tx.competitor.createMany({
            data: existing.competitors.map((c) => ({ knowledgePackId: newId, domain: c.domain, notes: c.notes })),
          });
        }

        await this.audit.recordWithinTransaction(tx, {
          action: "KNOWLEDGE_PACK_CREATED",
          actorUserId,
          workspaceId,
          entityType: "knowledge_pack",
          entityId: v2.publicId,
          ipAddress: context.ipAddress,
          beforeState: { clonedFrom: existing.publicId, clonedFromVersionNumber: existing.versionNumber },
          afterState: { versionNumber: v2.versionNumber, currentVersionOfId: existing.publicId },
        });

        return tx.knowledgePack.findUniqueOrThrow({ where: { id: newId }, include: KNOWLEDGE_PACK_INCLUDE });
      });
    } catch (err) {
      if (err instanceof PrismaNS.PrismaClientKnownRequestError && err.code === "P2002") {
        // knowledge_packs_one_successor_per_predecessor — a concurrent
        // request already created the next version from this same
        // predecessor first.
        throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "A successor version already exists for this Knowledge Pack; only one open successor is allowed at a time." });
      }
      throw err;
    }
  }

  /** Phase 2.4 §10 — every version in one lineage, oldest first, with each row's immediate predecessor resolved to its public_id (ADR-013 — the internal current_version_of never leaves this layer). */
  async listVersions(workspaceId: string, publicId: string) {
    const existing = await this.findOne(workspaceId, publicId);
    return this.prisma.knowledgePack.findMany({
      where: { workspaceId, lineageRootId: existing.lineageRootId, deletedAt: null },
      orderBy: { versionNumber: "asc" },
      include: { currentVersionOf: { select: { publicId: true } } },
    });
  }

  /**
   * Phase 2.3 (first version) + Phase 2.4 (successor supersession) —
   * Validation + Activation, per §7. A first-version Draft
   * (`currentVersionOfId === null`) runs the 4 FR-KP-005 gates only — there
   * is no predecessor to protect. A successor Draft additionally runs the
   * 5th gate (Owner Decision 7 RESTRICT: no Project may still reference the
   * predecessor) and, on success, archives the predecessor and activates
   * the successor atomically in the same transaction. See
   * MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §7/§8.
   */
  async validate(workspaceId: string, publicId: string, actorUserId: string, context: RequestContext): Promise<KnowledgePackWithChildren> {
    const existing = await this.findOne(workspaceId, publicId);

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
        // Existence was already confirmed above — a zero-row guarded
        // update here can only mean a concurrent caller already moved this
        // Draft out of DRAFT (another validate() call in flight, or an
        // edit raced this one). Nothing was written in this transaction
        // attempt, so rollback-via-throw is correct here.
        throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Only a Draft Knowledge Pack version may be validated." });
      }

      const pack = await tx.knowledgePack.findUniqueOrThrow({ where: { id: existing.id }, include: KNOWLEDGE_PACK_INCLUDE });
      const failures = this.runValidationGates(pack);

      // Gate 5 — Project-reference RESTRICT on the predecessor (§7/§8).
      // Only applies to a successor; a first version has no predecessor.
      let predecessor: KnowledgePack | null = null;
      if (pack.currentVersionOfId !== null) {
        predecessor = await tx.knowledgePack.findUniqueOrThrow({ where: { id: pack.currentVersionOfId } });
        const restrictingProjectCount = await tx.project.count({ where: { knowledgePackId: predecessor.id, deletedAt: null } });
        if (restrictingProjectCount > 0) {
          failures.push(
            `Blocked by ${restrictingProjectCount} Project(s) still referencing the predecessor version; reassign them before this version can activate (Owner Decision 7, RESTRICT).`,
          );
        }
      }

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
        if (predecessor) {
          // Archive-before-activate ordering is mandatory (§7) — the
          // partial unique index rejects the reverse order at the
          // statement level, since both rows would momentarily satisfy
          // (lineage_root_id, status='ACTIVE') simultaneously.
          const archived = await tx.knowledgePack.updateMany({
            where: { id: predecessor.id, status: "ACTIVE" },
            data: { status: "ARCHIVED", archivedAt: new Date() },
          });
          if (archived.count === 0) {
            throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "The predecessor version changed unexpectedly during supersession — retry." });
          }
        }

        const toActive = await tx.knowledgePack.updateMany({ where: { id: existing.id, status: "VALIDATING" }, data: { status: "ACTIVE" } });
        if (toActive.count === 0) {
          throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Knowledge Pack state changed unexpectedly during activation." });
        }
      } catch (err) {
        if (err instanceof PrismaNS.PrismaClientKnownRequestError && err.code === "P2002") {
          // knowledge_packs_one_active_per_lineage — another Active version
          // already exists for this lineage. The DB invariant is the final
          // backstop regardless of how the collision arose. Rolling back
          // (rethrow) leaves both rows exactly as they were pre-transaction.
          throw new ConflictException({ code: "KNOWLEDGE_CONFLICT", message: "Another Active version already exists for this Knowledge Pack lineage." });
        }
        throw err;
      }

      if (predecessor) {
        await this.audit.recordWithinTransaction(tx, {
          action: "KNOWLEDGE_PACK_ARCHIVED",
          actorUserId,
          workspaceId,
          entityType: "knowledge_pack",
          entityId: predecessor.publicId,
          ipAddress: context.ipAddress,
          beforeState: { status: "ACTIVE" },
          afterState: { status: "ARCHIVED", supersededBy: existing.publicId },
        });
      }
      await this.audit.recordWithinTransaction(tx, {
        action: "KNOWLEDGE_PACK_ACTIVATED",
        actorUserId,
        workspaceId,
        entityType: "knowledge_pack",
        entityId: existing.publicId,
        ipAddress: context.ipAddress,
        beforeState: { status: predecessor ? "VALIDATING" : "DRAFT" },
        afterState: predecessor ? { status: "ACTIVE", supersedes: predecessor.publicId } : { status: "ACTIVE" },
      });

      return { kind: "activated", pack: await tx.knowledgePack.findUniqueOrThrow({ where: { id: existing.id }, include: KNOWLEDGE_PACK_INCLUDE }) };
    });

    if (outcome.kind === "rejected") {
      throw new UnprocessableEntityException({ code: "KNOWLEDGE_VALIDATION_FAILED", message: "Knowledge Pack failed activation validation.", details: outcome.failures });
    }
    return outcome.pack;
  }

  /** The 4 FR-KP-005 gates, common to every Draft regardless of lineage position. Gate 5 (Project-reference RESTRICT on a predecessor) only applies to a successor and is evaluated separately in validate(), since it has no meaning for a first version. */
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
