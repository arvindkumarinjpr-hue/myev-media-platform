import { randomUUID } from "crypto";
import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  BLOG_BRIEF_AGENT_V1,
  BLOG_DRAFT_AGENT_V1,
  BLOG_OUTLINE_AGENT_V1,
  BlogBriefAgentOutput,
  BlogDraftAgentOutput,
  BlogOutlineAgentOutput,
  SEO_METADATA_AGENT_V1,
  SeoMetadataAgentOutput,
} from "@myev/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Prisma, type ContentItemStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AiJobSubmissionService } from "../ai-jobs/ai-job-submission.service";
import { ContentScoringService } from "../content-scoring/content-scoring.service";
import { ContentBodyValidator } from "../content/content-body-validator";
import { BLOG_ERRORS } from "./blog.errors";
import { deriveStage, emptyPipelineState, isPublishReady, readPipelineState, unmetReviewGates, writePipelineState } from "./blog-pipeline-state";
import { runQaChecks } from "./blog-qa";
import type { BriefStageState, DraftStageState, OutlineStageState, SeoStageState, BlogPipelineState } from "./blog-pipeline.types";

export interface BlogActor {
  userPublicId: string;
  userInternalId: string;
}

interface RequestContext {
  ipAddress?: string;
  correlationId: string;
}

/** Statuses in which the pipeline may still mutate an item (mirrors Module 1E EDITABLE_STATUSES). */
const EDITABLE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS"];

const LOCK_COLUMNS = `
  id, public_id AS "publicId", workspace_id AS "workspaceId", content_type AS "contentType",
  title, status, metadata, created_by AS "createdById", current_version_id AS "currentVersionId"
`;

interface LockedItem {
  id: string;
  publicId: string;
  workspaceId: string;
  contentType: string;
  title: string;
  status: ContentItemStatus;
  metadata: unknown;
  createdById: string;
  currentVersionId: string | null;
}

type GenerationStageKey = "brief" | "outline" | "draft" | "seo";

/**
 * Module 6 Phase 6.3 — Blog pipeline orchestration.
 *
 * Reuses, never reimplements: Module 3's `AiJobSubmissionService` (every
 * agent call is a durable `ai.execute.v1` job — no new queue/processor),
 * Module 1E's content-item lifecycle + immutable `content_versions`,
 * Module 6.1's `ContentScoringService` (all scoring math + persistence),
 * Module 2's Knowledge Pack authority (exact-version, ADR-004
 * non-substitution). The per-item stage bookkeeping lives in the generic
 * `content_items.metadata.blogPipeline` bag — no brief/outline/pipeline
 * tables (an explicit Phase 6.3 boundary).
 *
 * Every method is workspace-scoped structurally (a `workspaceId`
 * predicate on every query) and locks the `content_items` row
 * (`FOR UPDATE`) before reading-then-writing pipeline state, so
 * concurrent stage requests serialize instead of corrupting the blob.
 */
@Injectable()
export class BlogPipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly aiJobs: AiJobSubmissionService,
    private readonly scoring: ContentScoringService,
    private readonly bodyValidator: ContentBodyValidator,
  ) {}

  // ---------------------------------------------------------------------
  // Shared resolution + locking
  // ---------------------------------------------------------------------

  /** Resolve a BLOG pipeline item (workspace-scoped, enumeration-safe) and its current pipeline state. */
  async resolvePipeline(workspaceId: string, itemPublicId: string): Promise<{ item: LockedItem; state: BlogPipelineState }> {
    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: itemPublicId, workspaceId, deletedAt: null },
      select: { id: true, publicId: true, workspaceId: true, contentType: true, title: true, status: true, metadata: true, createdById: true, currentVersionId: true },
    });
    if (!item || item.contentType !== "BLOG") {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    const state = readPipelineState(item.metadata);
    if (!state) {
      throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_NOT_A_PIPELINE_ITEM, message: "This blog content item was not started as a pipeline article." });
    }
    return { item: item as LockedItem, state };
  }

  private async lockItem(tx: Prisma.TransactionClient, itemId: string): Promise<LockedItem> {
    const [row] = await tx.$queryRaw<LockedItem[]>`SELECT ${Prisma.raw(LOCK_COLUMNS)} FROM content_items WHERE id = ${itemId}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    return row;
  }

  private assertEditable(item: LockedItem): void {
    if (!EDITABLE_STATUSES.includes(item.status)) {
      throw new ConflictException({
        code: BLOG_ERRORS.BLOG_PIPELINE_ITEM_NOT_EDITABLE,
        message: `The article is "${item.status}" — pipeline stages can only run while it is DRAFT or IN_PROGRESS.`,
      });
    }
  }

  private async persistState(tx: Prisma.TransactionClient, item: LockedItem, state: BlogPipelineState, audit: { action: "CONTENT_ITEM_UPDATED"; afterState: Record<string, unknown>; actorInternalId: string | null; ipAddress?: string }): Promise<void> {
    await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, state) as Prisma.InputJsonValue } });
    await this.audit.recordWithinTransaction(tx, {
      action: audit.action,
      actorUserId: audit.actorInternalId,
      workspaceId: item.workspaceId,
      entityType: "content_item",
      entityId: item.publicId,
      afterState: audit.afterState,
      ipAddress: audit.ipAddress,
    });
  }

  // ---------------------------------------------------------------------
  // AI job reconciliation — reflect real ai_jobs state into the pipeline
  // ---------------------------------------------------------------------

  private readonly outputSchemas = {
    brief: BlogBriefAgentOutput,
    outline: BlogOutlineAgentOutput,
    draft: BlogDraftAgentOutput,
    seo: SeoMetadataAgentOutput,
  } as const;

  /**
   * For every generation stage that is GENERATING with a linked AI job,
   * pull the real ai_jobs row and advance the stage: COMPLETED + valid
   * output → READY (+ materialize a content_version for `draft`, a
   * blog_articles row for `seo`); COMPLETED + invalid output, or
   * FAILED/TIMED_OUT → FAILED with a reason. QUEUED/RUNNING → untouched.
   * Never fabricates output; never repairs it. A stage that is not yet
   * APPROVED and still carries an aiJobPublicId is always re-synced to
   * the linked job's current truth (so a job that later succeeds on a
   * retry lifts the stage out of a transient FAILED).
   */
  private async reconcile(tx: Prisma.TransactionClient, item: LockedItem, state: BlogPipelineState): Promise<{ state: BlogPipelineState; changed: boolean }> {
    let changed = false;
    for (const key of ["brief", "outline", "draft", "seo"] as GenerationStageKey[]) {
      const stage = state[key];
      if (!stage.aiJobPublicId || stage.status === "APPROVED") continue;
      const job = await tx.aiJob.findFirst({ where: { workspaceId: item.workspaceId, publicId: stage.aiJobPublicId, deletedAt: null } });
      if (!job) continue;

      if (job.status === "FAILED" || job.status === "TIMED_OUT") {
        if (stage.status !== "FAILED") {
          this.markStageFailed(state, key, job.errorCode ?? `AI job ${job.status}`);
          changed = true;
        }
        continue;
      }
      if (job.status !== "COMPLETED") continue;
      if (stage.status === "READY") continue;

      const parsed = await this.validateAgentOutput(key, job.outputPayload);
      if (!parsed.ok) {
        this.markStageFailed(state, key, `AI output failed ${key} schema validation`);
        changed = true;
        continue;
      }

      if (key === "brief") state.brief = { ...state.brief, status: "READY", artifact: parsed.value as BlogBriefAgentOutput, failureReason: null };
      else if (key === "outline") state.outline = { ...state.outline, status: "READY", artifact: parsed.value as BlogOutlineAgentOutput, failureReason: null };
      else if (key === "draft") {
        const versionPublicId = await this.persistDraftVersion(tx, item, parsed.value as BlogDraftAgentOutput);
        state.draft = { ...state.draft, status: "READY", artifact: parsed.value as BlogDraftAgentOutput, contentVersionPublicId: versionPublicId, failureReason: null };
      } else {
        const blogArticlePublicId = await this.persistSeoArticle(tx, item, parsed.value as SeoMetadataAgentOutput);
        state.seo = { ...state.seo, status: "READY", artifact: parsed.value as SeoMetadataAgentOutput, blogArticlePublicId, failureReason: null };
      }
      changed = true;
    }
    return { state, changed };
  }

  private markStageFailed(state: BlogPipelineState, key: GenerationStageKey, reason: string): void {
    this.patchStage(state, key, { status: "FAILED", failureReason: reason });
  }

  /** Type-safe per-key merge into one of the four generation stages. */
  private patchStage(
    state: BlogPipelineState,
    key: GenerationStageKey,
    patch: Partial<BriefStageState> & Partial<OutlineStageState> & Partial<DraftStageState> & Partial<SeoStageState>,
  ): void {
    if (key === "brief") state.brief = { ...state.brief, ...patch } as BriefStageState;
    else if (key === "outline") state.outline = { ...state.outline, ...patch } as OutlineStageState;
    else if (key === "draft") state.draft = { ...state.draft, ...patch } as DraftStageState;
    else state.seo = { ...state.seo, ...patch } as SeoStageState;
  }

  private async validateAgentOutput(key: GenerationStageKey, payload: unknown): Promise<{ ok: true; value: object } | { ok: false }> {
    if (!payload || typeof payload !== "object") return { ok: false };
    const ctor = this.outputSchemas[key] as new () => object;
    const instance = plainToInstance(ctor, payload as object);
    const errors = await validate(instance as object, { whitelist: false });
    return errors.length === 0 ? { ok: true, value: instance } : { ok: false };
  }

  /** FR-BLOG-003: the generated draft becomes a real immutable content_versions row — never overwriting history. */
  private async persistDraftVersion(tx: Prisma.TransactionClient, item: LockedItem, draft: BlogDraftAgentOutput): Promise<string> {
    const rendered = this.renderDraftBody(item.title, draft);
    this.bodyValidator.validate("BLOG", rendered);
    const latest = await tx.contentVersion.findFirst({ where: { contentItemId: item.id }, orderBy: { versionNumber: "desc" } });
    const versionNumber = (latest?.versionNumber ?? 0) + 1;
    const version = await tx.contentVersion.create({
      data: { id: randomUUID(), publicId: randomUUID(), contentItemId: item.id, versionNumber, body: rendered as Prisma.InputJsonValue, createdById: item.createdById },
    });
    await tx.contentItem.update({ where: { id: item.id }, data: { currentVersionId: version.id } });
    await this.audit.recordWithinTransaction(tx, {
      action: "CONTENT_VERSION_CREATED",
      actorUserId: item.createdById,
      workspaceId: item.workspaceId,
      entityType: "content_item",
      entityId: item.publicId,
      afterState: { versionNumber, source: "blog-draft-agent" },
    });
    return version.publicId;
  }

  private renderDraftBody(title: string, draft: BlogDraftAgentOutput): Record<string, unknown> {
    const md = [
      `# ${title}`,
      "",
      draft.introduction,
      ...draft.bodySections.flatMap((s) => ["", `${"#".repeat(Math.min(Math.max(s.level, 2), 4))} ${s.heading}`, "", s.content]),
      "",
      "## Conclusion",
      "",
      draft.conclusion,
      "",
      `**${draft.cta}**`,
      ...(draft.faqs.length > 0 ? ["", "## FAQ", ...draft.faqs.flatMap((f) => ["", `### ${f.question}`, "", f.answer])] : []),
    ].join("\n");
    return { content: md, blogDraft: draft as unknown as Record<string, unknown>, generatedBy: "blog-draft-agent" };
  }

  /** FR-SEO-001/002: persist/update the ONE blog_articles row for this item (workspace-safe 1:1). */
  private async persistSeoArticle(tx: Prisma.TransactionClient, item: LockedItem, seo: SeoMetadataAgentOutput): Promise<string> {
    const existing = await tx.blogArticle.findFirst({ where: { workspaceId: item.workspaceId, contentItemId: item.id } });
    if (existing) {
      const updated = await tx.blogArticle.update({
        where: { id: existing.id },
        data: {
          metaTitle: seo.metaTitle,
          metaDescription: seo.metaDescription,
          urlSlug: seo.urlSlug,
          schemaMarkup: seo.schemaMarkup as Prisma.InputJsonValue,
          updatedById: item.createdById,
        },
      });
      return updated.publicId;
    }
    const created = await tx.blogArticle.create({
      data: {
        id: randomUUID(),
        publicId: randomUUID(),
        workspaceId: item.workspaceId,
        contentItemId: item.id,
        metaTitle: seo.metaTitle,
        metaDescription: seo.metaDescription,
        urlSlug: seo.urlSlug,
        schemaMarkup: seo.schemaMarkup as Prisma.InputJsonValue,
        createdById: item.createdById,
      },
    });
    return created.publicId;
  }

  // ---------------------------------------------------------------------
  // Stage: generation (brief / outline / draft / seo)
  // ---------------------------------------------------------------------

  /**
   * Two-phase so the AI-job submission (its own transaction) never nests
   * inside the item lock: phase 1 validates prerequisites and CLAIMS the
   * stage (status → GENERATING) under the row lock — a concurrent request
   * now sees GENERATING and is rejected; phase 2 records the job id, or
   * rolls the stage to FAILED if submission threw.
   */
  private async runGenerationStage(
    workspaceId: string,
    actor: BlogActor,
    itemPublicId: string,
    key: GenerationStageKey,
    ctx: RequestContext,
  ): Promise<void> {
    const { agentInput, knowledgePackVersionId } = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const reconciled = await this.reconcile(tx, item, state);
      const cur = reconciled.state;
      if (cur[key].status === "GENERATING") {
        throw new ConflictException({ code: BLOG_ERRORS.BLOG_STAGE_ALREADY_RUNNING, message: `The ${key} stage is already generating.` });
      }
      this.assertPrerequisites(key, cur);

      const input = this.buildAgentInput(key, item, cur);

      // Claim + reset downstream (regenerating an already-approved stage
      // is an explicit transition — never a silent invalidation).
      this.claimStage(cur, key);
      await this.persistState(tx, item, cur, {
        action: "CONTENT_ITEM_UPDATED",
        afterState: { [`blogPipeline.${key}.status`]: "GENERATING" },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
      return { agentInput: input, knowledgePackVersionId: cur.knowledgePackVersionId };
    });

    let jobPublicId: string | null = null;
    let submitError: string | null = null;
    try {
      const job = await this.aiJobs.submit(
        workspaceId,
        actor.userInternalId,
        { agentIdentifier: this.agentFor(key).identifier, agentVersion: this.agentFor(key).version, knowledgePackVersionId, input: agentInput },
        ctx.correlationId,
      );
      jobPublicId = job.publicId;
    } catch (err) {
      submitError = err instanceof Error ? err.message : "AI job submission failed";
    }

    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      if (jobPublicId) {
        this.patchStage(state, key, { aiJobPublicId: jobPublicId, status: "GENERATING", failureReason: null });
      } else {
        this.patchStage(state, key, { status: "FAILED", failureReason: submitError ?? "AI job submission failed" });
      }
      await this.persistState(tx, item, state, {
        action: "CONTENT_ITEM_UPDATED",
        afterState: { [`blogPipeline.${key}.aiJobPublicId`]: jobPublicId, [`blogPipeline.${key}.status`]: state[key].status },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });

    if (submitError) {
      throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_STAGE_AI_OUTPUT_INVALID, message: `Could not start ${key} generation: ${submitError}` });
    }
  }

  private async loadLockedPipeline(tx: Prisma.TransactionClient, workspaceId: string, itemPublicId: string): Promise<{ item: LockedItem; state: BlogPipelineState }> {
    const found = await tx.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true } });
    if (!found || found.contentType !== "BLOG") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const item = await this.lockItem(tx, found.id);
    if (item.workspaceId !== workspaceId) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const state = readPipelineState(item.metadata);
    if (!state) throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_NOT_A_PIPELINE_ITEM, message: "This blog content item was not started as a pipeline article." });
    return { item, state };
  }

  private claimStage(state: BlogPipelineState, key: GenerationStageKey): void {
    const order: GenerationStageKey[] = ["brief", "outline", "draft", "seo"];
    const from = order.indexOf(key);
    // The claimed stage + every downstream generation stage reset — a
    // regenerated brief invalidates the outline built on it, etc.
    const fresh = emptyPipelineState(state.knowledgePackVersionId);
    for (let i = from; i < order.length; i++) {
      const k = order[i];
      if (k === "brief") state.brief = { ...fresh.brief, status: i === from ? "GENERATING" : "PENDING" };
      else if (k === "outline") state.outline = { ...fresh.outline, status: i === from ? "GENERATING" : "PENDING" };
      else if (k === "draft") state.draft = { ...fresh.draft, status: i === from ? "GENERATING" : "PENDING" };
      else state.seo = { ...fresh.seo, status: i === from ? "GENERATING" : "PENDING" };
    }
    // Deterministic downstream gates also reset when an upstream artifact changes.
    state.internalLinking = emptyPipelineState(state.knowledgePackVersionId).internalLinking;
    state.qa = emptyPipelineState(state.knowledgePackVersionId).qa;
    state.scoring = emptyPipelineState(state.knowledgePackVersionId).scoring;
  }

  private assertPrerequisites(key: GenerationStageKey, state: BlogPipelineState): void {
    if (key === "outline" && state.brief.status !== "APPROVED") {
      throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_BRIEF_NOT_APPROVED, message: "The brief must be approved before outline generation." });
    }
    if (key === "draft" && state.outline.status !== "APPROVED") {
      throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_OUTLINE_NOT_APPROVED, message: "The outline must be approved (Quality Gate #2) before draft generation." });
    }
    if (key === "seo" && (state.draft.status !== "READY" || !state.draft.contentVersionPublicId)) {
      throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_DRAFT_NOT_READY, message: "A generated draft is required before the SEO pass." });
    }
  }

  private agentFor(key: GenerationStageKey) {
    return { brief: BLOG_BRIEF_AGENT_V1, outline: BLOG_OUTLINE_AGENT_V1, draft: BLOG_DRAFT_AGENT_V1, seo: SEO_METADATA_AGENT_V1 }[key];
  }

  private buildAgentInput(key: GenerationStageKey, item: LockedItem, state: BlogPipelineState): Record<string, unknown> {
    const topic = item.title;
    if (key === "brief") return { topic };
    const brief = state.brief.artifact;
    if (!brief) throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_BRIEF_NOT_READY, message: "The approved brief artifact is missing." });
    if (key === "outline") {
      return {
        topic,
        searchIntent: brief.searchIntent,
        targetAudience: brief.targetAudience,
        primaryKeyword: brief.primaryKeyword,
        secondaryKeywords: brief.secondaryKeywords,
        ctaObjective: brief.ctaObjective,
      };
    }
    const outline = state.outline.artifact;
    if (!outline) throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_OUTLINE_NOT_READY, message: "The approved outline artifact is missing." });
    if (key === "draft") {
      return {
        topic,
        h1: outline.h1,
        sections: outline.sections,
        faqPlan: outline.faqPlan,
        primaryKeyword: brief.primaryKeyword,
        secondaryKeywords: brief.secondaryKeywords,
        targetAudience: brief.targetAudience,
        ctaObjective: brief.ctaObjective,
      };
    }
    const draft = state.draft.artifact;
    if (!draft) throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_DRAFT_NOT_READY, message: "The generated draft artifact is missing." });
    return {
      topic,
      title: outline.h1,
      primaryKeyword: brief.primaryKeyword,
      secondaryKeywords: brief.secondaryKeywords,
      articleSummary: draft.introduction.slice(0, 500) || draft.conclusion.slice(0, 500),
    };
  }

  async generateBrief(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "brief", ctx);
  }
  async generateOutline(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "outline", ctx);
  }
  async generateDraft(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "draft", ctx);
  }
  async generateSeo(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "seo", ctx);
  }

  // ---------------------------------------------------------------------
  // Stage: approvals (brief / outline)
  // ---------------------------------------------------------------------

  async approveBrief(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.approveGeneration(workspaceId, actor, itemPublicId, "brief", ctx);
  }
  async approveOutline(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.approveGeneration(workspaceId, actor, itemPublicId, "outline", ctx);
  }

  private async approveGeneration(workspaceId: string, actor: BlogActor, itemPublicId: string, key: "brief" | "outline", ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const reconciled = (await this.reconcile(tx, item, state)).state;
      const stage = reconciled[key];
      if (stage.status === "FAILED") {
        throw new UnprocessableEntityException({ code: key === "brief" ? BLOG_ERRORS.BLOG_BRIEF_NOT_READY : BLOG_ERRORS.BLOG_OUTLINE_NOT_READY, message: `The ${key} generation failed — regenerate it before approving.` });
      }
      if (stage.status !== "READY") {
        throw new UnprocessableEntityException({
          code: key === "brief" ? BLOG_ERRORS.BLOG_BRIEF_NOT_READY : BLOG_ERRORS.BLOG_OUTLINE_NOT_READY,
          message: `The ${key} is "${stage.status}" — it must be generated and READY before approval.`,
        });
      }
      const approvedPatch = { status: "APPROVED" as const, approvedAt: new Date().toISOString(), approvedByUserPublicId: actor.userPublicId };
      if (key === "brief") reconciled.brief = { ...reconciled.brief, ...approvedPatch };
      else reconciled.outline = { ...reconciled.outline, ...approvedPatch };
      await this.persistState(tx, item, reconciled, {
        action: "CONTENT_ITEM_UPDATED",
        afterState: { [`blogPipeline.${key}.status`]: "APPROVED" },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Stage: internal linking (FR-BLOG-005 seam — Module 8 not built)
  // ---------------------------------------------------------------------

  async runInternalLinking(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const reconciled = (await this.reconcile(tx, item, state)).state;
      if (reconciled.seo.status !== "READY") {
        throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_SEO_NOT_READY, message: "The SEO pass must complete before internal linking." });
      }
      // FR-BLOG-005: "No related content found → pass completes with zero
      // suggestions, not an error." Module 8 (the real engine) is not
      // built in Phase 6.3 — the stage/seam exists and returns zero
      // suggestions with an explicit typed status until it lands. No
      // external search, no fabricated links.
      reconciled.internalLinking = { status: "COMPLETED", suggestions: [], reason: "engine_not_available", completedAt: new Date().toISOString() };
      await this.persistState(tx, item, reconciled, {
        action: "CONTENT_ITEM_UPDATED",
        afterState: { "blogPipeline.internalLinking.status": "COMPLETED", "blogPipeline.internalLinking.reason": "engine_not_available" },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Stage: QA (FR-BLOG-006 — deterministic checks)
  // ---------------------------------------------------------------------

  async runQa(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    const brandTerms = await this.loadBrandTerms(workspaceId);
    const corpusTexts = await this.loadWorkspaceBlogCorpus(workspaceId, itemPublicId);
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const reconciled = (await this.reconcile(tx, item, state)).state;
      if (reconciled.draft.status !== "READY" || !reconciled.draft.artifact) {
        throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_DRAFT_NOT_READY, message: "A generated draft is required before QA." });
      }
      if (reconciled.internalLinking.status !== "COMPLETED") {
        throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_INTERNAL_LINKING_NOT_COMPLETE, message: "The internal-linking pass must complete before QA (FR-BLOG-006 depends on FR-BLOG-005)." });
      }
      const checks = runQaChecks({
        draft: reconciled.draft.artifact,
        primaryKeyword: reconciled.brief.artifact?.primaryKeyword ?? "",
        brandTerms,
        corpusTexts,
      });
      reconciled.qa = { status: "COMPLETED", checks, completedAt: new Date().toISOString() };
      await this.persistState(tx, item, reconciled, {
        action: "CONTENT_ITEM_UPDATED",
        afterState: { "blogPipeline.qa.status": "COMPLETED", "blogPipeline.qa.failed": checks.filter((c) => !c.passed).map((c) => c.id) },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  private async loadBrandTerms(workspaceId: string): Promise<string[]> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: { brandGuidelines: { select: { terminology: true } } },
    });
    if (!pack) return [];
    const terms = new Set<string>();
    for (const bg of pack.brandGuidelines) {
      const t = bg.terminology;
      if (t && typeof t === "object" && !Array.isArray(t)) {
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (typeof k === "string" && k.trim()) terms.add(k.trim());
          if (typeof v === "string" && v.trim()) terms.add(v.trim());
        }
      }
    }
    return [...terms];
  }

  private async loadWorkspaceBlogCorpus(workspaceId: string, excludeItemPublicId: string): Promise<string[]> {
    const rows = await this.prisma.contentItem.findMany({
      where: { workspaceId, contentType: "BLOG", deletedAt: null, publicId: { not: excludeItemPublicId }, currentVersionId: { not: null } },
      select: { currentVersion: { select: { body: true } } },
      take: 200,
    });
    const texts: string[] = [];
    for (const r of rows) {
      const body = r.currentVersion?.body;
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const content = (body as Record<string, unknown>).content;
        if (typeof content === "string" && content.trim()) texts.push(content);
      }
    }
    return texts;
  }

  // ---------------------------------------------------------------------
  // Stage: scoring integration (reuses Phase 6.1 — no re-implemented math)
  // ---------------------------------------------------------------------

  async runScoring(workspaceId: string, actor: BlogActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    // Gate check under the lock first, then score (ContentScoringService
    // runs its own transaction), then record the summary under the lock.
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled } = await this.reconcile(tx, item, state);
      if (reconciled.qa.status !== "COMPLETED") {
        throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_QA_NOT_COMPLETE, message: "QA must complete before scoring." });
      }
      await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, reconciled) as Prisma.InputJsonValue } });
    });

    const run = await this.scoring.score(workspaceId, itemPublicId, { internalId: actor.userInternalId });

    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      state.scoring = {
        status: "COMPLETED",
        contentScorePublicId: run.contentScorePublicId,
        overallScore: run.result.overallScore,
        passThreshold: run.threshold.threshold,
        passed: run.threshold.passed,
        ranAt: run.calculatedAt.toISOString(),
      };
      await this.persistState(tx, item, state, {
        action: "CONTENT_ITEM_UPDATED",
        afterState: { "blogPipeline.scoring.overall": run.result.overallScore, "blogPipeline.scoring.passed": run.threshold.passed },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Read model
  // ---------------------------------------------------------------------

  async getReadModel(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown>> {
    const found = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true } });
    if (!found || found.contentType !== "BLOG") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });

    const item = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lockItem(tx, found.id);
      const state = readPipelineState(locked.metadata);
      if (!state) return { locked, state: null as BlogPipelineState | null };
      const reconciled = await this.reconcile(tx, locked, state);
      if (reconciled.changed) {
        await tx.contentItem.update({ where: { id: locked.id }, data: { metadata: writePipelineState(locked.metadata, reconciled.state) as Prisma.InputJsonValue } });
      }
      return { locked, state: reconciled.state };
    });

    if (!item.state) {
      throw new UnprocessableEntityException({ code: BLOG_ERRORS.BLOG_NOT_A_PIPELINE_ITEM, message: "This blog content item was not started as a pipeline article." });
    }
    return this.serializeReadModel(item.locked, item.state);
  }

  private serializeReadModel(item: LockedItem, state: BlogPipelineState): Record<string, unknown> {
    const gates = unmetReviewGates(state);
    return {
      contentItem: { publicId: item.publicId, title: item.title, contentType: item.contentType, status: item.status },
      knowledgePackVersionId: state.knowledgePackVersionId,
      currentStage: deriveStage(state, item.status),
      publishReady: isPublishReady(item.status),
      brief: { status: state.brief.status, aiJobPublicId: state.brief.aiJobPublicId, artifact: state.brief.artifact, approvedAt: state.brief.approvedAt, failureReason: state.brief.failureReason },
      outline: { status: state.outline.status, aiJobPublicId: state.outline.aiJobPublicId, artifact: state.outline.artifact, approvedAt: state.outline.approvedAt, failureReason: state.outline.failureReason },
      draft: { status: state.draft.status, aiJobPublicId: state.draft.aiJobPublicId, contentVersionPublicId: state.draft.contentVersionPublicId, failureReason: state.draft.failureReason },
      seo: { status: state.seo.status, aiJobPublicId: state.seo.aiJobPublicId, blogArticlePublicId: state.seo.blogArticlePublicId, artifact: state.seo.artifact, failureReason: state.seo.failureReason },
      internalLinking: state.internalLinking,
      qa: state.qa,
      scoring: state.scoring,
      reviewGatesUnmet: gates,
      canSubmitForReview: gates.length === 0 && ["DRAFT", "IN_PROGRESS"].includes(item.status),
    };
  }

  // ---------------------------------------------------------------------
  // Human-review handoff — delegates to Module 1E, never re-implements it
  // ---------------------------------------------------------------------

  /** Enforce every upstream Quality Gate, then hand off. Below-threshold score can never bypass this. */
  async assertReadyForReview(workspaceId: string, itemPublicId: string): Promise<void> {
    const { state } = await this.resolvePipeline(workspaceId, itemPublicId);
    // A fresh read reconciles nothing new here; the gate list is authoritative.
    const gates = unmetReviewGates(state);
    if (gates.length === 0) return;
    if (gates.includes("content_score_passed")) {
      throw new UnprocessableEntityException({
        code: BLOG_ERRORS.SEO_SCORE_BELOW_THRESHOLD,
        message: `Content score ${state.scoring.overallScore ?? "?"} is below the pass threshold ${state.scoring.passThreshold ?? "?"}. Address the itemized recommendations, regenerate the draft, and re-score before review.`,
      });
    }
    const first = gates[0];
    const map: Record<string, string> = {
      brief_approved: BLOG_ERRORS.BLOG_BRIEF_NOT_APPROVED,
      outline_approved: BLOG_ERRORS.BLOG_OUTLINE_NOT_APPROVED,
      draft_generated: BLOG_ERRORS.BLOG_DRAFT_NOT_READY,
      seo_complete: BLOG_ERRORS.BLOG_SEO_NOT_READY,
      internal_links_added: BLOG_ERRORS.BLOG_INTERNAL_LINKING_NOT_COMPLETE,
      qa_complete: BLOG_ERRORS.BLOG_QA_NOT_COMPLETE,
      content_score_run: BLOG_ERRORS.SEO_SCORE_NOT_RUN,
    };
    throw new UnprocessableEntityException({ code: map[first] ?? BLOG_ERRORS.BLOG_QA_NOT_COMPLETE, message: `Cannot submit for review — unmet Quality Gates: ${gates.join(", ")}.` });
  }

  /** The itemized improvement feedback exposed when a score blocks review (FR-BLOG-006 error condition). */
  async getScoreFeedback(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown> | null> {
    const latest = await this.scoring.getLatest(workspaceId, itemPublicId);
    if (!latest) return null;
    return {
      overallScore: latest.result.overallScore,
      passThreshold: latest.threshold.threshold,
      passed: latest.threshold.passed,
      categoryScores: latest.result.categoryScores,
      recommendations: latest.result.recommendations,
      factors: latest.result.factors,
    };
  }
}
