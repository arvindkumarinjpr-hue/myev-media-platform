import { VIDEO_PIPELINE_METADATA_KEY, type VideoPipelineStage, type VideoPipelineState } from "./video-pipeline.types";

/**
 * Module 7 Phase 7.1/7.2 — pure helpers over the video pipeline state
 * blob. No I/O, no NestJS. The one place the
 * `content_items.metadata.videoPipeline` shape is read, defaulted, and
 * reduced to a coarse stage label + the publish-ready flag. Everything
 * here is deterministic and unit-tested in isolation
 * (video-pipeline-state.spec.ts). Mirrors `blog-pipeline-state.ts`.
 */

export function emptyPipelineState(knowledgePackVersionId: string, videoScriptPublicId: string): VideoPipelineState {
  return {
    knowledgePackVersionId,
    videoScriptPublicId,
    brief: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null },
    script: { status: "PENDING", aiJobPublicId: null, artifact: null, approvedAt: null, approvedByUserPublicId: null, failureReason: null },
    scenePlan: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null },
    assets: { status: "PENDING", scenes: [], missingScenes: [], completedAt: null, failureReason: null },
    voice: {
      status: "PENDING",
      audioAssetPublicId: null,
      wordTimingObjectKey: null,
      scriptVersionHash: null,
      voiceProfileId: null,
      audioDurationMs: null,
      mediaJobPublicId: null,
      failureReason: null,
    },
    subtitles: {
      status: "PENDING",
      srtAssetPublicId: null,
      vttAssetPublicId: null,
      sourceAudioAssetPublicId: null,
      cueCount: null,
      mediaJobPublicId: null,
      failureReason: null,
    },
    render: {
      status: "PENDING",
      renderJobPublicId: null,
      renderedVideoPublicId: null,
      renderedVideoAssetGroupId: null,
      exportProfileId: null,
      attempt: 0,
      expectedDurationMs: null,
      outputWidth: null,
      outputHeight: null,
      outputDurationMs: null,
      outputChecksumSha256: null,
      outputByteSize: null,
      scriptVersionHash: null,
      sceneAssetFingerprint: null,
      voiceAudioAssetPublicId: null,
      subtitleVttAssetPublicId: null,
      snapshotScenes: [],
      brandingLayerConfigured: false,
      brandingLogoInSnapshot: false,
      brandingIntroRequired: false,
      brandingIntroRendered: false,
      brandingOutroRequired: false,
      brandingOutroRendered: false,
      completedAt: null,
      failureReason: null,
    },
    qa: { status: "PENDING", checks: [], passed: null, renderJobPublicId: null, renderedVideoPublicId: null, completedAt: null },
    seo: { status: "PENDING", aiJobPublicId: null, videoScriptPublicId: null, artifact: null, failureReason: null },
    thumbnailConcepts: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null },
    thumbnailImage: {
      status: "PENDING",
      selectedConceptIndex: null,
      imageAssetPublicId: null,
      imageAssetGroupId: null,
      imageWidth: null,
      imageHeight: null,
      mediaJobPublicId: null,
      failureReason: null,
    },
    recommendations: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null },
    score: { status: "PENDING", contentScorePublicId: null, overallScore: null, videoScore: null, thumbnailScore: null, passThreshold: null, passed: null, ranAt: null },
  };
}

/**
 * Reads the pipeline state out of a content item's metadata bag. Returns
 * null when the item was never started as a Video pipeline (a plain
 * Module 1E video content item) — callers turn that into
 * VIDEO_NOT_A_PIPELINE_ITEM.
 */
export function readPipelineState(metadata: unknown): VideoPipelineState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[VIDEO_PIPELINE_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Partial<VideoPipelineState>;
  if (typeof state.knowledgePackVersionId !== "string" || typeof state.videoScriptPublicId !== "string") return null;
  // Merge onto a fresh skeleton so a state written by an older shape can
  // never surface `undefined` for a stage the current code reads.
  const base = emptyPipelineState(state.knowledgePackVersionId, state.videoScriptPublicId);
  return {
    knowledgePackVersionId: state.knowledgePackVersionId,
    videoScriptPublicId: state.videoScriptPublicId,
    brief: { ...base.brief, ...state.brief },
    script: { ...base.script, ...state.script },
    scenePlan: { ...base.scenePlan, ...state.scenePlan },
    assets: { ...base.assets, ...state.assets },
    voice: { ...base.voice, ...state.voice },
    subtitles: { ...base.subtitles, ...state.subtitles },
    render: { ...base.render, ...state.render },
    qa: { ...base.qa, ...state.qa },
    seo: { ...base.seo, ...state.seo },
    thumbnailConcepts: { ...base.thumbnailConcepts, ...state.thumbnailConcepts },
    thumbnailImage: { ...base.thumbnailImage, ...state.thumbnailImage },
    recommendations: { ...base.recommendations, ...state.recommendations },
    score: { ...base.score, ...state.score },
  };
}

/**
 * Writes the pipeline state back into a metadata bag, preserving every
 * other key an operator or Module 1E may have set on the same item.
 */
export function writePipelineState(metadata: unknown, state: VideoPipelineState): Record<string, unknown> {
  const bag = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  bag[VIDEO_PIPELINE_METADATA_KEY] = state;
  return bag;
}

/**
 * True once a content item's metadata carries a Video pipeline bag. Used
 * by the shared Module 1E review-gate seal to recognise a
 * pipeline-governed VIDEO item without importing this module (it inlines
 * the same key check — see ContentItemsService.isVideoPipelineItem).
 * Kept here as the single source of truth for the shape.
 */
export function hasVideoPipeline(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const raw = (metadata as Record<string, unknown>)[VIDEO_PIPELINE_METADATA_KEY];
  return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Every gate the human-review handoff requires, per the frozen 8 Quality
 * Gates (VIDEO_AUTOMATION_ENGINE_V1.0.md) PLUS the config-driven scoring
 * gate (mirrors Blog's own `content_score_run` / `content_score_passed`
 * pair exactly). Gate #7 (Human Approval) and #8 (Publish Ready) are the
 * review action + the APPROVED state itself, so they are not listed
 * among the *pre-review* unmet gates. Advisory stages (thumbnailConcepts,
 * recommendations) never appear here — they never gate anything.
 *
 * Gates #2–#5 (assets/voice/render/qa) are Phase 7.4/7.5 territory: no
 * Phase 7.3 code path ever sets them READY/COMPLETED, so they are
 * ALWAYS present in this list for a naturally-created item today — by
 * design, this makes submit-for-review structurally unreachable in
 * production until those phases land (checkpoint §10: "This is
 * EXPECTED").
 */
export function unmetReviewGates(state: VideoPipelineState): string[] {
  const gates: string[] = [];
  if (state.script.status !== "APPROVED") gates.push("script_approved");
  if (state.assets.status !== "READY") gates.push("assets_available");
  if (state.voice.status !== "READY") gates.push("voice_generated");
  if (state.render.status !== "READY") gates.push("rendering_successful");
  if (state.qa.status !== "COMPLETED" || state.qa.passed !== true) gates.push("qa_passed");
  if (state.seo.status !== "READY") gates.push("seo_complete");
  if (state.score.status !== "COMPLETED") gates.push("content_score_run");
  else if (state.score.passed !== true) gates.push("content_score_passed");
  return gates;
}

/**
 * Coarse "where is it" label for the read model — derived from stage
 * statuses + the content item's own lifecycle status, never stored as a
 * source of truth. `itemStatus` is the Module 1E ContentItemStatus.
 */
export function deriveStage(state: VideoPipelineState, itemStatus: string): VideoPipelineStage {
  if (itemStatus === "APPROVED") return "PUBLISH_READY";
  if (itemStatus === "REVIEW") return "IN_REVIEW";
  if (state.brief.status !== "READY") return "BRIEF";
  if (state.script.status !== "APPROVED") return "SCRIPT";
  if (state.scenePlan.status !== "READY") return "SCENE_PLAN";
  if (state.assets.status !== "READY") return "ASSETS";
  if (state.voice.status !== "READY") return "VOICE";
  if (state.subtitles.status !== "READY") return "SUBTITLES";
  if (state.render.status !== "READY") return "RENDER";
  if (state.qa.status !== "COMPLETED") return "QA";
  if (state.seo.status !== "READY") return "SEO";
  return "READY_FOR_REVIEW";
}

/** §24.6: "Publish Ready" is the gate label for an APPROVED video content item — never publishing itself (Module 9). */
export function isPublishReady(itemStatus: string): boolean {
  return itemStatus === "APPROVED";
}
