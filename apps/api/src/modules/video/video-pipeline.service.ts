import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  THUMBNAIL_CONCEPT_AGENT_V1,
  VIDEO_BRIEF_AGENT_V1,
  VIDEO_RECOMMENDATIONS_AGENT_V1,
  VIDEO_SCENE_PLANNER_AGENT_V1,
  VIDEO_SCRIPT_AGENT_V1,
  VIDEO_SEO_METADATA_AGENT_V1,
  validateVideoScenePlan,
  type ThumbnailConceptAgentOutput,
  type VideoBriefAgentOutput,
  type VideoRecommendationsAgentOutput,
  type VideoScenePlannerAgentOutput,
  type VideoScriptAgentOutput,
  type VideoSeoMetadataAgentOutput,
} from "@myev/shared";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Prisma, type ContentItemStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { AiJobSubmissionService } from "../ai-jobs/ai-job-submission.service";
import { VIDEO_ERRORS } from "./video.errors";
import { VideoScoringService } from "./video-scoring.service";
import { deriveStage, emptyPipelineState, isPublishReady, readPipelineState, unmetReviewGates, writePipelineState } from "./video-pipeline-state";
import type {
  AdvisoryStageKey,
  BriefStageState,
  RecommendationsStageState,
  ScenePlanStageState,
  ScriptStageState,
  SeoStageState,
  TextGenerationStageKey,
  ThumbnailConceptsStageState,
  VideoPipelineState,
} from "./video-pipeline.types";

export interface VideoActor {
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

/** The 6 stages Phase 7.2 actually executes as `ai.execute.v1` jobs — 4 mandatory + 2 advisory. */
type GenerationKey = TextGenerationStageKey | AdvisoryStageKey;
const ALL_GENERATION_KEYS: GenerationKey[] = ["brief", "script", "scenePlan", "seo", "thumbnailConcepts", "recommendations"];

interface VideoScriptRow {
  publicId: string;
  targetPlatform: string;
  exportProfile: string | null;
  durationSecondsTarget: number | null;
}

/**
 * Module 7 Phase 7.1/7.2 — Video pipeline orchestration.
 *
 * Structural mirror of Module 6's `BlogPipelineService`: reuses, never
 * reimplements, `AiJobSubmissionService` (every agent call is a durable
 * `ai.execute.v1` job — no new queue/processor, no direct provider SDK
 * calls) and Module 1E's content-item lifecycle. The per-item stage
 * bookkeeping lives in `content_items.metadata.videoPipeline`; the real
 * script/scene-plan/SEO artifacts land on the 1:1 `video_scripts` row.
 *
 * Invariants carried from the Blog precedent:
 *  - workspace isolation: every query carries a `workspaceId` predicate.
 *  - explicit mutation/read boundary: `projectReadModel` performs ZERO
 *    writes. `finalizeStages` (mutating, persists artifacts) only ever
 *    runs from an authorized mutating method, under the `content_items`
 *    row lock. `projectStages` (read-only) computes the same live status
 *    for GET with zero writes.
 *  - `runGenerationStage` is two-phase, exactly like Blog's: phase 1
 *    validates prerequisites and CLAIMS the stage under the row lock;
 *    phase 2 (outside the lock) submits the durable AI job, then records
 *    the job id (or marks FAILED) under a second lock.
 */
@Injectable()
export class VideoPipelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly aiJobs: AiJobSubmissionService,
    private readonly videoScoring: VideoScoringService,
  ) {}

  // ---------------------------------------------------------------------
  // Shared resolution + locking
  // ---------------------------------------------------------------------

  private async lockItem(tx: Prisma.TransactionClient, itemId: string): Promise<LockedItem> {
    const [row] = await tx.$queryRaw<LockedItem[]>`SELECT ${Prisma.raw(LOCK_COLUMNS)} FROM content_items WHERE id = ${itemId}::uuid FOR UPDATE`;
    if (!row) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    return row;
  }

  private assertEditable(item: LockedItem): void {
    if (!EDITABLE_STATUSES.includes(item.status)) {
      throw new ConflictException({
        code: VIDEO_ERRORS.VIDEO_PIPELINE_ITEM_NOT_EDITABLE,
        message: `The video is "${item.status}" — pipeline stages can only run while it is DRAFT or IN_PROGRESS.`,
      });
    }
  }

  private async loadLockedPipeline(tx: Prisma.TransactionClient, workspaceId: string, itemPublicId: string): Promise<{ item: LockedItem; state: VideoPipelineState }> {
    const found = await tx.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { id: true, contentType: true } });
    if (!found || found.contentType !== "VIDEO") throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const item = await this.lockItem(tx, found.id);
    if (item.workspaceId !== workspaceId) throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    const state = readPipelineState(item.metadata);
    if (!state) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    return { item, state };
  }

  private async persistState(tx: Prisma.TransactionClient, item: LockedItem, state: VideoPipelineState, audit: { afterState: Record<string, unknown>; actorInternalId: string | null; ipAddress?: string }): Promise<void> {
    await tx.contentItem.update({ where: { id: item.id }, data: { metadata: writePipelineState(item.metadata, state) as Prisma.InputJsonValue } });
    await this.audit.recordWithinTransaction(tx, {
      action: "CONTENT_ITEM_UPDATED",
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
    brief: VIDEO_BRIEF_AGENT_V1.outputSchema!,
    script: VIDEO_SCRIPT_AGENT_V1.outputSchema!,
    scenePlan: VIDEO_SCENE_PLANNER_AGENT_V1.outputSchema!,
    seo: VIDEO_SEO_METADATA_AGENT_V1.outputSchema!,
    thumbnailConcepts: THUMBNAIL_CONCEPT_AGENT_V1.outputSchema!,
    recommendations: VIDEO_RECOMMENDATIONS_AGENT_V1.outputSchema!,
  } as const;

  private async validateAgentOutput(key: GenerationKey, payload: unknown): Promise<{ ok: true; value: object } | { ok: false }> {
    if (!payload || typeof payload !== "object") return { ok: false };
    const ctor = this.outputSchemas[key] as new () => object;
    const instance = plainToInstance(ctor, payload as object);
    const errors = await validate(instance as object, { whitelist: false });
    return errors.length === 0 ? { ok: true, value: instance } : { ok: false };
  }

  private markStageFailed(state: VideoPipelineState, key: GenerationKey, reason: string): void {
    const patch = { status: "FAILED" as const, failureReason: reason };
    if (key === "brief") state.brief = { ...state.brief, ...patch };
    else if (key === "script") state.script = { ...state.script, ...patch };
    else if (key === "scenePlan") state.scenePlan = { ...state.scenePlan, ...patch };
    else if (key === "seo") state.seo = { ...state.seo, ...patch };
    else if (key === "thumbnailConcepts") state.thumbnailConcepts = { ...state.thumbnailConcepts, ...patch };
    else state.recommendations = { ...state.recommendations, ...patch };
  }

  /** video_scripts is 1:1 (contentItemId is unique) — plain idempotent UPDATE, no exactly-once guard needed (unlike Blog's append-only content_versions). */
  private async persistScriptBody(tx: Prisma.TransactionClient, item: LockedItem, script: VideoScriptAgentOutput): Promise<void> {
    await tx.videoScript.update({ where: { contentItemId: item.id }, data: { scriptBody: script.scriptBody ?? null } });
  }

  private async persistScenePlan(tx: Prisma.TransactionClient, item: LockedItem, plan: VideoScenePlannerAgentOutput): Promise<void> {
    await tx.videoScript.update({ where: { contentItemId: item.id }, data: { scenePlan: plan as unknown as Prisma.InputJsonValue } });
  }

  private async persistSeoMetadata(tx: Prisma.TransactionClient, item: LockedItem, seo: VideoSeoMetadataAgentOutput): Promise<void> {
    await tx.videoScript.update({
      where: { contentItemId: item.id },
      data: {
        metaTitle: seo.metaTitle,
        metaDescription: seo.metaDescription,
        tags: seo.tags as unknown as Prisma.InputJsonValue,
        chapters: seo.chapters as unknown as Prisma.InputJsonValue,
        hashtags: seo.hashtags as unknown as Prisma.InputJsonValue,
        schemaMarkup: seo.schemaMarkup as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * For every generation stage that is GENERATING with a linked AI job,
   * pull the real ai_jobs row and advance the stage: COMPLETED + valid
   * output → READY (+ materialize onto video_scripts for script /
   * scenePlan / seo); COMPLETED + invalid output, or FAILED/TIMED_OUT →
   * FAILED with a reason. QUEUED/RUNNING → untouched. Never fabricates
   * output; never repairs it.
   *
   * scenePlan gets an EXTRA pipeline-level cross-field check
   * (`validateVideoScenePlan` against the currently-approved script's
   * real segment ids) before being accepted — defense in depth on top of
   * the agent's own `postProcessOutput` (checkpoint D8: "reject malformed
   * or incomplete Scene Planner output before persisting it").
   *
   * MUTATING — only ever called from an authorized mutating stage method,
   * under a `content_items` row lock, inside that mutation's transaction.
   * A `GET` (VIDEO_VIEW) never reaches this; it uses `projectStages`.
   */
  private async finalizeStages(tx: Prisma.TransactionClient, item: LockedItem, state: VideoPipelineState): Promise<{ state: VideoPipelineState; changed: boolean }> {
    let changed = false;
    for (const key of ALL_GENERATION_KEYS) {
      const stage = state[key];
      if (!stage.aiJobPublicId || stage.status === "APPROVED" || stage.status === "READY") continue;
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

      const parsed = await this.validateAgentOutput(key, job.outputPayload);
      if (!parsed.ok) {
        this.markStageFailed(state, key, `AI output failed ${key} schema validation`);
        changed = true;
        continue;
      }

      if (key === "brief") {
        state.brief = { ...state.brief, status: "READY", artifact: parsed.value as VideoBriefAgentOutput, failureReason: null };
      } else if (key === "script") {
        await this.persistScriptBody(tx, item, parsed.value as VideoScriptAgentOutput);
        state.script = { ...state.script, status: "READY", artifact: parsed.value as VideoScriptAgentOutput, failureReason: null };
      } else if (key === "scenePlan") {
        const scriptSegments = state.script.artifact?.segments ?? [];
        const cross = validateVideoScenePlan(parsed.value as VideoScenePlannerAgentOutput, { scriptSegmentIds: scriptSegments.map((s) => s.id) });
        if (!cross.ok) {
          this.markStageFailed(state, key, `Scene plan failed structural validation: ${cross.errors.join("; ")}`);
          changed = true;
          continue;
        }
        await this.persistScenePlan(tx, item, parsed.value as VideoScenePlannerAgentOutput);
        state.scenePlan = { ...state.scenePlan, status: "READY", artifact: parsed.value as VideoScenePlannerAgentOutput, failureReason: null };
      } else if (key === "seo") {
        await this.persistSeoMetadata(tx, item, parsed.value as VideoSeoMetadataAgentOutput);
        state.seo = { ...state.seo, status: "READY", artifact: parsed.value as VideoSeoMetadataAgentOutput, videoScriptPublicId: state.videoScriptPublicId, failureReason: null };
      } else if (key === "thumbnailConcepts") {
        state.thumbnailConcepts = { ...state.thumbnailConcepts, status: "READY", artifact: parsed.value as ThumbnailConceptAgentOutput, failureReason: null };
      } else {
        state.recommendations = { ...state.recommendations, status: "READY", artifact: parsed.value as VideoRecommendationsAgentOutput, failureReason: null };
      }
      changed = true;
    }
    return { state, changed };
  }

  /**
   * READ-ONLY sibling of `finalizeStages` — computes the same live status
   * (schema-valid COMPLETED → READY; FAILED/TIMED_OUT/invalid → FAILED)
   * WITHOUT writing anything: no metadata update, no video_scripts write,
   * no audit. `scenePlan` ALSO runs the `validateVideoScenePlan`
   * cross-field check here (it is a pure function over already-loaded
   * state — no I/O, so it costs nothing to share with the mutating path)
   * so a GET can never display a stale "READY" for a scene plan the next
   * mutating call would reject; only the actual PERSISTENCE onto
   * video_scripts stays exclusive to `finalizeStages`. This is what
   * `GET /video/:id` (VIDEO_VIEW) uses.
   */
  private async projectStages(state: VideoPipelineState, jobsByPublicId: Map<string, { status: string; outputPayload: unknown; errorCode: string | null }>): Promise<VideoPipelineState> {
    const derived: VideoPipelineState = JSON.parse(JSON.stringify(state));
    for (const key of ALL_GENERATION_KEYS) {
      const stage = derived[key];
      if (!stage.aiJobPublicId || stage.status === "APPROVED" || stage.status === "READY") continue;
      const job = jobsByPublicId.get(stage.aiJobPublicId);
      if (!job) continue;
      if (job.status === "FAILED" || job.status === "TIMED_OUT") {
        this.markStageFailed(derived, key, stage.failureReason ?? job.errorCode ?? `AI job ${job.status}`);
        continue;
      }
      if (job.status !== "COMPLETED") continue;
      const parsed = await this.validateAgentOutput(key, job.outputPayload);
      if (!parsed.ok) {
        this.markStageFailed(derived, key, `AI output failed ${key} schema validation`);
        continue;
      }
      if (key === "scenePlan") {
        const scriptSegments = derived.script.artifact?.segments ?? [];
        const cross = validateVideoScenePlan(parsed.value as VideoScenePlannerAgentOutput, { scriptSegmentIds: scriptSegments.map((s) => s.id) });
        if (!cross.ok) {
          this.markStageFailed(derived, key, `Scene plan failed structural validation: ${cross.errors.join("; ")}`);
          continue;
        }
      }
      const patch = { status: "READY" as const, failureReason: null };
      if (key === "brief") derived.brief = { ...derived.brief, ...patch };
      else if (key === "script") derived.script = { ...derived.script, ...patch };
      else if (key === "scenePlan") derived.scenePlan = { ...derived.scenePlan, ...patch };
      else if (key === "seo") derived.seo = { ...derived.seo, ...patch };
      else if (key === "thumbnailConcepts") derived.thumbnailConcepts = { ...derived.thumbnailConcepts, ...patch };
      else derived.recommendations = { ...derived.recommendations, ...patch };
    }
    return derived;
  }

  // ---------------------------------------------------------------------
  // Stage: generation (brief / script / scenePlan / seo / thumbnailConcepts / recommendations)
  // ---------------------------------------------------------------------

  /**
   * Regenerating a stage invalidates it and every MANDATORY stage
   * downstream of it — never an advisory stage, and never an upstream
   * one:
   *  - brief    → resets script(+Gate #1 approval), scenePlan, and every
   *               media/QA stage those feed (all still PENDING today).
   *  - script   → resets scenePlan + the same downstream media/QA set.
   *               Gate #1 approval is cleared (a new script is
   *               unapproved by definition).
   *  - scenePlan→ resets ONLY scenePlan + downstream media/render
   *               placeholders. Never touches script approval (task
   *               §13) and never touches seo (a sibling of scenePlan,
   *               not downstream of it).
   *  - seo      → resets ONLY seo/Gate #6 (task §13: "only affects SEO
   *               artifact/Gate #6").
   *  - thumbnailConcepts / recommendations → reset ONLY themselves
   *    (advisory — never invalidates a mandatory gate).
   */
  private claimStage(state: VideoPipelineState, key: GenerationKey): void {
    const fresh = emptyPipelineState(state.knowledgePackVersionId, state.videoScriptPublicId);
    if (key === "brief") {
      state.brief = { ...fresh.brief, status: "GENERATING" };
      state.script = fresh.script;
      state.scenePlan = fresh.scenePlan;
      state.assets = fresh.assets;
      state.voice = fresh.voice;
      state.subtitles = fresh.subtitles;
      state.render = fresh.render;
      state.qa = fresh.qa;
      state.seo = fresh.seo;
      state.score = fresh.score; // any previous score is stale — the whole video changed
    } else if (key === "script") {
      state.script = { ...fresh.script, status: "GENERATING" };
      state.scenePlan = fresh.scenePlan;
      state.assets = fresh.assets;
      state.voice = fresh.voice;
      state.subtitles = fresh.subtitles;
      state.render = fresh.render;
      state.qa = fresh.qa;
      state.seo = fresh.seo;
      state.score = fresh.score;
    } else if (key === "scenePlan") {
      state.scenePlan = { ...fresh.scenePlan, status: "GENERATING" };
      state.assets = fresh.assets;
      state.voice = fresh.voice;
      state.subtitles = fresh.subtitles;
      state.render = fresh.render;
      state.qa = fresh.qa;
      state.score = fresh.score; // scene coverage feeds the Video Score's QUALITY factors
    } else if (key === "seo") {
      state.seo = { ...fresh.seo, status: "GENERATING" };
      state.score = fresh.score; // SEO metadata feeds the Video Score's SEO factors
    } else if (key === "thumbnailConcepts") {
      state.thumbnailConcepts = { ...fresh.thumbnailConcepts, status: "GENERATING" };
      state.score = fresh.score; // the persisted Thumbnail Score would otherwise reflect the OLD concept
    } else {
      // recommendations: advisory, never scored — never invalidates freshness.
      state.recommendations = { ...fresh.recommendations, status: "GENERATING" };
    }
  }

  private assertPrerequisites(key: GenerationKey, state: VideoPipelineState): void {
    if (key === "script" && state.brief.status !== "READY") {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_BRIEF_NOT_READY, message: "The brief must be generated before script generation." });
    }
    if (key === "scenePlan" && state.script.status !== "APPROVED") {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_APPROVED, message: "The script must be approved (Quality Gate #1) before scene planning." });
    }
    if (key === "seo" && state.script.status !== "APPROVED") {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_APPROVED, message: "The script must be approved (Quality Gate #1) before SEO generation." });
    }
    if ((key === "thumbnailConcepts" || key === "recommendations") && state.script.status !== "READY" && state.script.status !== "APPROVED") {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_READY, message: "A generated script is required first." });
    }
  }

  private agentFor(key: GenerationKey) {
    return {
      brief: VIDEO_BRIEF_AGENT_V1,
      script: VIDEO_SCRIPT_AGENT_V1,
      scenePlan: VIDEO_SCENE_PLANNER_AGENT_V1,
      seo: VIDEO_SEO_METADATA_AGENT_V1,
      thumbnailConcepts: THUMBNAIL_CONCEPT_AGENT_V1,
      recommendations: VIDEO_RECOMMENDATIONS_AGENT_V1,
    }[key];
  }

  private buildAgentInput(key: GenerationKey, item: LockedItem, videoScript: VideoScriptRow, state: VideoPipelineState): Record<string, unknown> {
    const topic = item.title;
    if (key === "brief") {
      return { topic, targetPlatform: videoScript.targetPlatform, ...(videoScript.durationSecondsTarget ? { durationSecondsTarget: videoScript.durationSecondsTarget } : {}) };
    }
    const brief = state.brief.artifact;
    if (!brief) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_BRIEF_NOT_READY, message: "The generated brief artifact is missing." });
    if (key === "script") {
      return { topic, targetPlatform: brief.targetPlatform, objective: brief.objective, audience: brief.audience, durationSeconds: brief.durationSeconds, cta: brief.cta };
    }
    const script = state.script.artifact;
    if (!script) throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_READY, message: "The approved script artifact is missing." });
    if (key === "scenePlan") {
      return { topic, targetPlatform: brief.targetPlatform, durationSeconds: brief.durationSeconds, hook: script.hook, segments: script.segments };
    }
    // SEO / thumbnailConcepts / recommendations all derive a short
    // summary from the script's own narration — no scene-plan dependency
    // (SEO's prerequisite is Gate #1 only; a scene plan need not exist).
    const scriptSummary = script.segments.map((s) => s.narration).join(" ").slice(0, 500);
    if (key === "seo") {
      // Segment offsets are seeded at 0 (no timing exists before
      // Phase 7.4/7.5) — advisory context for chapter drafting only,
      // never authoritative; postProcessOutput validates the AGENT's
      // actual chapter output, not this seed.
      const segmentOutline = script.segments.map((s) => ({ label: s.label, startSeconds: 0 }));
      return { topic, targetPlatform: brief.targetPlatform, objective: brief.objective, audience: brief.audience, durationSeconds: brief.durationSeconds, hook: script.hook, scriptSummary, segmentOutline };
    }
    if (key === "thumbnailConcepts") {
      return { topic, targetPlatform: brief.targetPlatform, hook: script.hook, objective: brief.objective, audience: brief.audience };
    }
    // recommendations
    return { topic, targetPlatform: brief.targetPlatform, objective: brief.objective, hook: script.hook, scriptSummary };
  }

  private async loadVideoScript(workspaceId: string, contentItemId: string): Promise<VideoScriptRow> {
    const row = await this.prisma.videoScript.findFirstOrThrow({
      where: { workspaceId, contentItemId, deletedAt: null },
      select: { publicId: true, targetPlatform: true, exportProfile: true, durationSecondsTarget: true },
    });
    return row;
  }

  /**
   * Two-phase so the AI-job submission (its own transaction) never nests
   * inside the item lock: phase 1 validates prerequisites and CLAIMS the
   * stage (status → GENERATING) under the row lock; phase 2 records the
   * job id, or rolls the stage to FAILED if submission threw.
   */
  private async runGenerationStage(workspaceId: string, actor: VideoActor, itemPublicId: string, key: GenerationKey, ctx: RequestContext): Promise<void> {
    const { agentInput, knowledgePackVersionId } = await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const reconciled = (await this.finalizeStages(tx, item, state)).state;
      if (reconciled[key].status === "GENERATING") {
        throw new ConflictException({ code: VIDEO_ERRORS.VIDEO_STAGE_ALREADY_RUNNING, message: `The ${key} stage is already generating.` });
      }
      this.assertPrerequisites(key, reconciled);

      const videoScript = await this.loadVideoScript(workspaceId, item.id);
      const input = this.buildAgentInput(key, item, videoScript, reconciled);

      this.claimStage(reconciled, key);
      await this.persistState(tx, item, reconciled, {
        afterState: { [`videoPipeline.${key}.status`]: "GENERATING" },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
      return { agentInput: input, knowledgePackVersionId: reconciled.knowledgePackVersionId };
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
        this.patchStagePublicId(state, key, jobPublicId);
      } else {
        this.markStageFailed(state, key, submitError ?? "AI job submission failed");
      }
      await this.persistState(tx, item, state, {
        afterState: { [`videoPipeline.${key}.aiJobPublicId`]: jobPublicId, [`videoPipeline.${key}.status`]: state[key].status },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });

    if (submitError) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_STAGE_AI_OUTPUT_INVALID, message: `Could not start ${key} generation: ${submitError}` });
    }
  }

  private patchStagePublicId(state: VideoPipelineState, key: GenerationKey, jobPublicId: string): void {
    const patch = { aiJobPublicId: jobPublicId, status: "GENERATING" as const, failureReason: null };
    if (key === "brief") state.brief = { ...state.brief, ...patch };
    else if (key === "script") state.script = { ...state.script, ...patch };
    else if (key === "scenePlan") state.scenePlan = { ...state.scenePlan, ...patch };
    else if (key === "seo") state.seo = { ...state.seo, ...patch };
    else if (key === "thumbnailConcepts") state.thumbnailConcepts = { ...state.thumbnailConcepts, ...patch };
    else state.recommendations = { ...state.recommendations, ...patch };
  }

  async generateBrief(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "brief", ctx);
  }
  async generateScript(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "script", ctx);
  }
  async generateScenePlan(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "scenePlan", ctx);
  }
  async generateSeo(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "seo", ctx);
  }
  /** ADVISORY — a failure here never blocks any other stage or gate. */
  async generateThumbnailConcepts(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "thumbnailConcepts", ctx);
  }
  /** ADVISORY — a failure here never blocks any other stage or gate. */
  async generateRecommendations(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.runGenerationStage(workspaceId, actor, itemPublicId, "recommendations", ctx);
  }

  // ---------------------------------------------------------------------
  // Stage: Quality Gate #1 — Script Approved
  // ---------------------------------------------------------------------

  async approveScript(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const reconciled = (await this.finalizeStages(tx, item, state)).state;
      if (reconciled.script.status === "FAILED") {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_READY, message: "The script generation failed — regenerate it before approving." });
      }
      if (reconciled.script.status !== "READY") {
        throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_READY, message: `The script is "${reconciled.script.status}" — it must be generated and READY before approval.` });
      }
      reconciled.script = { ...reconciled.script, status: "APPROVED", approvedAt: new Date().toISOString(), approvedByUserPublicId: actor.userPublicId };
      await this.persistState(tx, item, reconciled, {
        afterState: { "videoPipeline.script.status": "APPROVED" },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Stage: scoring integration (reuses VideoScoringService — all scoring
  // math + persistence lives there, mirroring how Blog's runScoring
  // reuses Phase 6.1's ContentScoringService).
  // ---------------------------------------------------------------------

  async runScore(workspaceId: string, actor: VideoActor, itemPublicId: string, ctx: RequestContext): Promise<void> {
    // Materialize any pending completed stages first (same pattern as
    // Blog's own runScoring), so the score is built from the freshest
    // persisted artifacts available — never a stage still sitting
    // COMPLETED-but-unmaterialized in ai_jobs.
    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: reconciled, changed } = await this.finalizeStages(tx, item, state);
      if (changed) {
        await this.persistState(tx, item, reconciled, {
          afterState: { "videoPipeline.finalizedForScoring": true },
          actorInternalId: actor.userInternalId,
          ipAddress: ctx.ipAddress,
        });
      }
    });

    const run = await this.videoScoring.score(workspaceId, itemPublicId, { internalId: actor.userInternalId });

    await this.prisma.$transaction(async (tx) => {
      const { item, state } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      state.score = {
        status: "COMPLETED",
        contentScorePublicId: run.contentScorePublicId,
        overallScore: run.videoResult.overallScore,
        videoScore: run.videoResult.dimension.score,
        thumbnailScore: run.thumbnailResult?.dimension.score ?? null,
        passThreshold: run.threshold.threshold,
        passed: run.threshold.passed,
        ranAt: run.calculatedAt.toISOString(),
      };
      await this.persistState(tx, item, state, {
        afterState: { "videoPipeline.score.overall": run.videoResult.overallScore, "videoPipeline.score.passed": run.threshold.passed },
        actorInternalId: actor.userInternalId,
        ipAddress: ctx.ipAddress,
      });
    });
  }

  /**
   * READ-ONLY. The latest score for this VIDEO pipeline item — overall +
   * the five universal category scores + the Video Score + the
   * Thumbnail Score (null when no concept existed at scoring time) +
   * itemized factors/recommendations + the pass decision. Enumeration-
   * safe and workspace-scoped. Never runs or re-runs scoring.
   */
  async getScoreFeedback(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown> | null> {
    const item = await this.prisma.contentItem.findFirst({ where: { publicId: itemPublicId, workspaceId, deletedAt: null }, select: { contentType: true, metadata: true } });
    if (!item || item.contentType !== "VIDEO") {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    if (!readPipelineState(item.metadata)) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    }

    const latest = await this.videoScoring.getLatest(workspaceId, itemPublicId);
    if (!latest) return null;
    return {
      overallScore: latest.videoResult.overallScore,
      passThreshold: latest.threshold.threshold,
      passed: latest.threshold.passed,
      categoryScores: latest.videoResult.categoryScores,
      videoScore: { ...latest.videoResult.dimension },
      thumbnailScore: latest.thumbnailResult ? { ...latest.thumbnailResult.dimension } : null,
      factors: latest.videoResult.factors,
      thumbnailFactors: latest.thumbnailResult?.factors ?? [],
      recommendations: latest.videoResult.recommendations,
      thumbnailRecommendations: latest.thumbnailResult?.recommendations ?? [],
      calculatedAt: latest.calculatedAt,
    };
  }

  // ---------------------------------------------------------------------
  // Human-review handoff — delegates to Module 1E, never re-implements it
  // (mirrors Blog's assertReadyForReview exactly).
  // ---------------------------------------------------------------------

  async assertReadyForReview(workspaceId: string, itemPublicId: string, actor: VideoActor, ctx: RequestContext): Promise<void> {
    const state = await this.prisma.$transaction(async (tx) => {
      const { item, state: cur } = await this.loadLockedPipeline(tx, workspaceId, itemPublicId);
      this.assertEditable(item);
      const { state: finalized, changed } = await this.finalizeStages(tx, item, cur);
      if (changed) {
        await this.persistState(tx, item, finalized, {
          afterState: { "videoPipeline.finalizedForReview": true },
          actorInternalId: actor.userInternalId,
          ipAddress: ctx.ipAddress,
        });
      }
      return finalized;
    });

    const gates = unmetReviewGates(state);
    if (gates.length === 0) return;
    if (gates.includes("content_score_passed")) {
      throw new UnprocessableEntityException({
        code: VIDEO_ERRORS.VIDEO_SCORE_BELOW_THRESHOLD,
        message: `Content score ${state.score.overallScore ?? "?"} is below the pass threshold ${state.score.passThreshold ?? "?"}. Address the itemized recommendations and re-score before review.`,
      });
    }
    const first = gates[0];
    const map: Record<string, string> = {
      script_approved: VIDEO_ERRORS.VIDEO_SCRIPT_NOT_APPROVED,
      assets_available: VIDEO_ERRORS.VIDEO_ASSETS_NOT_AVAILABLE,
      voice_generated: VIDEO_ERRORS.VIDEO_VOICE_NOT_GENERATED,
      rendering_successful: VIDEO_ERRORS.VIDEO_RENDER_NOT_SUCCESSFUL,
      qa_passed: VIDEO_ERRORS.VIDEO_QA_NOT_PASSED,
      seo_complete: VIDEO_ERRORS.VIDEO_SEO_NOT_COMPLETE,
      content_score_run: VIDEO_ERRORS.VIDEO_SCORE_NOT_RUN,
    };
    throw new UnprocessableEntityException({ code: map[first] ?? VIDEO_ERRORS.VIDEO_QA_NOT_PASSED, message: `Cannot submit for review — unmet Quality Gates: ${gates.join(", ")}.` });
  }

  // ---------------------------------------------------------------------
  // Read model — READ-ONLY. Never locks, never opens a write transaction,
  // never persists. Safe under VIDEO_VIEW.
  // ---------------------------------------------------------------------

  async projectReadModel(workspaceId: string, itemPublicId: string): Promise<Record<string, unknown>> {
    const item = await this.prisma.contentItem.findFirst({
      where: { publicId: itemPublicId, workspaceId, deletedAt: null },
      select: { id: true, publicId: true, contentType: true, title: true, status: true, metadata: true, createdAt: true, updatedAt: true },
    });
    if (!item || item.contentType !== "VIDEO") {
      throw new NotFoundException({ code: "CONTENT_ITEM_NOT_FOUND", message: "Content item not found." });
    }
    const state = readPipelineState(item.metadata);
    if (!state) {
      throw new UnprocessableEntityException({ code: VIDEO_ERRORS.VIDEO_NOT_A_PIPELINE_ITEM, message: "This video content item was not started as a pipeline video." });
    }

    const jobIds = ALL_GENERATION_KEYS.map((k) => state[k].aiJobPublicId).filter((id): id is string => !!id);
    const jobs = jobIds.length
      ? await this.prisma.aiJob.findMany({ where: { workspaceId, publicId: { in: jobIds }, deletedAt: null }, select: { publicId: true, status: true, outputPayload: true, errorCode: true } })
      : [];
    const jobsByPublicId = new Map(jobs.map((j) => [j.publicId, j]));
    const derived = await this.projectStages(state, jobsByPublicId);

    const script = await this.prisma.videoScript.findFirst({
      where: { workspaceId, contentItemId: item.id, deletedAt: null },
      select: { publicId: true, targetPlatform: true, exportProfile: true, durationSecondsTarget: true },
    });

    return this.serializeReadModel(item, state, derived, script);
  }

  private serializeReadModel(
    item: { publicId: string; title: string; contentType: string; status: ContentItemStatus; createdAt: Date; updatedAt: Date },
    persisted: VideoPipelineState,
    derived: VideoPipelineState,
    script: VideoScriptRow | null,
  ): Record<string, unknown> {
    const gates = unmetReviewGates(derived);
    const brief = this.serializeGenerationStage(derived.brief, persisted.brief);
    const script_ = this.serializeGenerationStage(derived.script, persisted.script) as ReturnType<typeof this.serializeGenerationStage> & { approvedAt: string | null; scriptApproved: boolean };
    script_.approvedAt = persisted.script.approvedAt;
    script_.scriptApproved = persisted.script.status === "APPROVED";
    const scenePlan = this.serializeGenerationStage(derived.scenePlan, persisted.scenePlan);
    const seo = this.serializeGenerationStage(derived.seo, persisted.seo) as ReturnType<typeof this.serializeGenerationStage> & { seoComplete: boolean };
    // Derived (not persisted) — matches unmetReviewGates(derived)'s own
    // "seo_complete" check: Gate #6 reflects live job truth, same as the
    // gate list itself, unlike `scriptApproved` (an explicit, persisted-
    // only human action that is never re-derived from a job).
    seo.seoComplete = derived.seo.status === "READY";
    const thumbnailConcepts = { ...this.serializeGenerationStage(derived.thumbnailConcepts, persisted.thumbnailConcepts), advisory: true };
    const recommendations = { ...this.serializeGenerationStage(derived.recommendations, persisted.recommendations), advisory: true };

    return {
      contentItem: { publicId: item.publicId, title: item.title, contentType: item.contentType, status: item.status },
      knowledgePackVersionId: persisted.knowledgePackVersionId,
      videoScript: script ? { publicId: script.publicId, targetPlatform: script.targetPlatform, exportProfile: script.exportProfile, durationSecondsTarget: script.durationSecondsTarget } : null,
      currentStage: deriveStage(derived, item.status),
      publishReady: isPublishReady(item.status),
      brief,
      script: script_,
      scenePlan,
      assets: persisted.assets,
      voice: persisted.voice,
      subtitles: persisted.subtitles,
      render: persisted.render,
      qa: persisted.qa,
      seo,
      thumbnailConcepts,
      recommendations,
      score: persisted.score,
      reviewGatesUnmet: gates,
      canSubmitForReview: gates.length === 0 && ["DRAFT", "IN_PROGRESS"].includes(item.status),
      timestamps: { createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() },
    };
  }

  private serializeGenerationStage(
    derived: BriefStageState | ScriptStageState | ScenePlanStageState | SeoStageState | ThumbnailConceptsStageState | RecommendationsStageState,
    persisted: BriefStageState | ScriptStageState | ScenePlanStageState | SeoStageState | ThumbnailConceptsStageState | RecommendationsStageState,
  ): { status: string; aiJobPublicId: string | null; artifact: unknown; failureReason: string | null } {
    return { status: derived.status, aiJobPublicId: persisted.aiJobPublicId, artifact: persisted.artifact, failureReason: derived.failureReason };
  }
}
