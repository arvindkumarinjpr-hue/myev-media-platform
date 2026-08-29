/**
 * Module 7 Phase 7.1 — Video Automation pipeline orchestration state.
 *
 * Mirrors Module 6's `blog-pipeline.types.ts` exactly. The pipeline's
 * per-item progress is persisted in the EXISTING generic
 * `content_items.metadata` JSON bag under the `videoPipeline` key — Module
 * 1E deliberately provides this "generic, type-agnostic bag" precisely so
 * type-specific orchestration state does not need its own table. No
 * video_pipeline / brief / scene tables are introduced (an explicit Phase
 * 7.1 boundary, same as Blog Phase 6.3).
 *
 * The `video_scripts` row (1:1, `target_platform` + the eventual
 * script_body / scene_plan / SEO metadata) is real persistence. Only the
 * orchestration bookkeeping — which stage, which AI job, whether an
 * artifact was approved — lives in this metadata bag.
 *
 * Phase 7.1 does not EXECUTE any stage: every stage starts and stays
 * `PENDING`. The full 10-stage shape is defined now so that Phases
 * 7.2–7.5 are purely additive (checkpoint §8 "future stage contracts").
 */

export const VIDEO_PIPELINE_METADATA_KEY = "videoPipeline" as const;

/**
 * The frozen 8 Quality Gates (VIDEO_AUTOMATION_ENGINE_V1.0.md "Quality
 * Gates" / FRD §11): Script Approved, Assets Available, Voice Generated,
 * Rendering Successful, QA Passed, SEO Complete, Human Approval, Publish
 * Ready.
 */
export const VIDEO_QUALITY_GATES = [
  "script_approved",
  "assets_available",
  "voice_generated",
  "rendering_successful",
  "qa_passed",
  "seo_complete",
  "human_approval",
  "publish_ready",
] as const;
export type VideoQualityGate = (typeof VIDEO_QUALITY_GATES)[number];

/** A generation stage backed by an AI text job (brief / script / scene / seo). */
export type GenerationStageStatus = "PENDING" | "GENERATING" | "READY" | "APPROVED" | "FAILED";

/** A media stage backed by a MEDIA-queue job (assets / voice / subtitles / render) — Phases 7.4–7.5. */
export type MediaStageStatus = "PENDING" | "RUNNING" | "READY" | "FAILED";

/** A deterministic stage with no job of its own (qa). */
export type DeterministicStageStatus = "PENDING" | "COMPLETED";

/**
 * Phase 7.1 keeps every stage's structured artifact loosely typed
 * (`Record<string, unknown> | null`). Phase 7.2 replaces these with the
 * real `@myev/shared` agent output types (VideoBriefAgentOutput,
 * VideoScriptAgentOutput, …) — the field names here do not change.
 */
type Artifact = Record<string, unknown> | null;

export interface BriefStageState {
  /**
   * The frozen workflow has no "Brief Approved" quality gate (Gate #1 is
   * "Script Approved"), so the brief's terminal status is READY, not
   * APPROVED — same as Blog's draft/seo stages.
   */
  status: GenerationStageStatus;
  /** publicId of the most recent ai_jobs row for this stage — history is never destroyed. */
  aiJobPublicId: string | null;
  artifact: Artifact;
  failureReason: string | null;
}

export interface ScriptStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  artifact: Artifact;
  /** Quality Gate #1 — Script Approved. */
  approvedAt: string | null;
  approvedByUserPublicId: string | null;
  failureReason: string | null;
}

export interface ScenePlanStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  artifact: Artifact;
  failureReason: string | null;
}

export interface AssetSceneRef {
  sceneRef: string;
  mediaAssetPublicId: string | null;
  source: "uploaded" | "ai_generated" | "unresolved";
}

export interface AssetStageState {
  status: MediaStageStatus;
  scenes: AssetSceneRef[];
  /** FR-VID-005: Quality Gate #2 blocks with an itemized list of scenes still missing an asset. */
  missingScenes: string[];
  completedAt: string | null;
  failureReason: string | null;
}

export interface VoiceStageState {
  status: MediaStageStatus;
  /** media_assets (audio_assets extension) publicId — Phase 7.4. */
  audioAssetPublicId: string | null;
  mediaJobPublicId: string | null;
  failureReason: string | null;
}

export interface SubtitleStageState {
  status: MediaStageStatus;
  subtitleAssetPublicId: string | null;
  mediaJobPublicId: string | null;
  failureReason: string | null;
}

export interface RenderStageState {
  status: MediaStageStatus;
  /** background_jobs publicId for the VideoRenderJob (checkpoint D5) — Phase 7.5. */
  renderJobPublicId: string | null;
  renderedVideoPublicId: string | null;
  /** FR-VID-007: rendering resumes rather than restarts — the attempt counter is retry-limited. */
  attempt: number;
  failureReason: string | null;
}

export interface QaCheckResult {
  id: "missing_assets" | "audio_sync" | "subtitle_sync" | "resolution" | "duration" | "branding";
  label: string;
  passed: boolean;
  explanation: string;
  evidence: string[];
}

export interface QaStageState {
  status: DeterministicStageStatus;
  /** The frozen 6 QA Engine checks (FR-VID-008). */
  checks: QaCheckResult[];
  completedAt: string | null;
}

export interface SeoStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  /** Written onto the video_scripts row (meta_title / meta_description / tags / chapters / hashtags / schema_markup). */
  videoScriptPublicId: string | null;
  artifact: Artifact;
  failureReason: string | null;
}

export interface VideoPipelineState {
  /** The EXACT Knowledge Pack version publicId this pipeline is bound to, locked at create time (ADR-004 non-substitution). */
  knowledgePackVersionId: string;
  /** The video_scripts row backing this pipeline (1:1). */
  videoScriptPublicId: string;
  brief: BriefStageState;
  script: ScriptStageState;
  scenePlan: ScenePlanStageState;
  assets: AssetStageState;
  voice: VoiceStageState;
  subtitles: SubtitleStageState;
  render: RenderStageState;
  qa: QaStageState;
  seo: SeoStageState;
}

/** Coarse read-model label for "where is this video in the pipeline right now". Derived, never stored as the source of truth. */
export type VideoPipelineStage =
  | "BRIEF"
  | "SCRIPT"
  | "SCENE_PLAN"
  | "ASSETS"
  | "VOICE"
  | "SUBTITLES"
  | "RENDER"
  | "QA"
  | "SEO"
  | "READY_FOR_REVIEW"
  | "IN_REVIEW"
  | "APPROVED"
  | "PUBLISH_READY";
