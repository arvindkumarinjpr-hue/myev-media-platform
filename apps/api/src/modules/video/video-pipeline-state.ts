import { VIDEO_PIPELINE_METADATA_KEY, type VideoPipelineStage, type VideoPipelineState } from "./video-pipeline.types";

/**
 * Module 7 Phase 7.1 — pure helpers over the video pipeline state blob.
 * No I/O, no NestJS. The one place the
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
    voice: { status: "PENDING", audioAssetPublicId: null, mediaJobPublicId: null, failureReason: null },
    subtitles: { status: "PENDING", subtitleAssetPublicId: null, mediaJobPublicId: null, failureReason: null },
    render: { status: "PENDING", renderJobPublicId: null, renderedVideoPublicId: null, attempt: 0, failureReason: null },
    qa: { status: "PENDING", checks: [], completedAt: null },
    seo: { status: "PENDING", aiJobPublicId: null, videoScriptPublicId: null, artifact: null, failureReason: null },
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
 * True once the item's metadata carries a Video pipeline bag. Used by the
 * shared Module 1E review-gate seal to recognise a pipeline-governed
 * VIDEO item without importing this module (it inlines the same key
 * check). Kept here as the single source of truth for the shape.
 */
export function hasVideoPipeline(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const raw = (metadata as Record<string, unknown>)[VIDEO_PIPELINE_METADATA_KEY];
  return !!raw && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * Every gate the human-review handoff requires, per the frozen 8 Quality
 * Gates (VIDEO_AUTOMATION_ENGINE_V1.0.md). Gate #7 (Human Approval) and
 * #8 (Publish Ready) are the review action + the APPROVED state itself,
 * so they are not listed among the *pre-review* unmet gates. In Phase 7.1
 * no stage can be executed, so this always returns the full pre-review
 * set for a freshly created pipeline — submit-for-review is not wired
 * until Phase 7.3, and the shared seal (below) blocks the generic route.
 */
export function unmetReviewGates(state: VideoPipelineState): string[] {
  const gates: string[] = [];
  if (state.script.status !== "APPROVED") gates.push("script_approved");
  if (state.assets.status !== "READY") gates.push("assets_available");
  if (state.voice.status !== "READY") gates.push("voice_generated");
  if (state.render.status !== "READY") gates.push("rendering_successful");
  if (state.qa.status !== "COMPLETED") gates.push("qa_passed");
  if (state.seo.status !== "READY") gates.push("seo_complete");
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
