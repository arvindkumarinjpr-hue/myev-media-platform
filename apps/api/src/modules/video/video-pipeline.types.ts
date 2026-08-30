/**
 * Module 7 Phase 7.1/7.2 — Video Automation pipeline orchestration state.
 *
 * Mirrors Module 6's `blog-pipeline.types.ts`. The pipeline's per-item
 * progress is persisted in the EXISTING generic `content_items.metadata`
 * JSON bag under the `videoPipeline` key — Module 1E deliberately
 * provides this "generic, type-agnostic bag" precisely so type-specific
 * orchestration state does not need its own table. No video_pipeline /
 * brief / scene tables are introduced (an explicit Phase 7.1 boundary,
 * same as Blog Phase 6.3).
 *
 * The `video_scripts` row (1:1, `target_platform` + script_body /
 * scene_plan / SEO metadata) is real persistence. Only the orchestration
 * bookkeeping — which stage, which AI job, whether Gate #1 was approved —
 * lives in this metadata bag.
 */
import type {
  ThumbnailConceptAgentOutput,
  VideoBriefAgentOutput,
  VideoRecommendationsAgentOutput,
  VideoScenePlannerAgentOutput,
  VideoScriptAgentOutput,
  VideoSeoMetadataAgentOutput,
} from "@myev/shared";

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

/** A generation stage backed by an AI text job (brief / script / scenePlan / seo). */
export type GenerationStageStatus = "PENDING" | "GENERATING" | "READY" | "APPROVED" | "FAILED";

/** An advisory generation stage (thumbnailConcepts / recommendations) — never gates anything. */
export type AdvisoryStageStatus = "PENDING" | "GENERATING" | "READY" | "FAILED";

/** A media stage backed by a MEDIA-queue job (assets / voice / subtitles / render) — Phases 7.4–7.5. */
export type MediaStageStatus = "PENDING" | "RUNNING" | "READY" | "FAILED";

/** A deterministic stage with no job of its own (qa). */
export type DeterministicStageStatus = "PENDING" | "COMPLETED";

export interface BriefStageState {
  /**
   * The frozen workflow has no "Brief Approved" quality gate (Gate #1 is
   * "Script Approved"), so the brief's terminal status is READY, not
   * APPROVED — same as Blog's draft/seo stages.
   */
  status: GenerationStageStatus;
  /** publicId of the most recent ai_jobs row for this stage — history is never destroyed. */
  aiJobPublicId: string | null;
  artifact: VideoBriefAgentOutput | null;
  failureReason: string | null;
}

export interface ScriptStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  artifact: VideoScriptAgentOutput | null;
  /** Quality Gate #1 — Script Approved. */
  approvedAt: string | null;
  approvedByUserPublicId: string | null;
  failureReason: string | null;
}

export interface ScenePlanStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  artifact: VideoScenePlannerAgentOutput | null;
  failureReason: string | null;
}

/** How a scene's required asset was resolved (checkpoint §10 / Gate #2). */
export type SceneAssetSource = "uploaded" | "brand" | "ai_generated";

export interface AssetSceneRef {
  /** The ScenePlan scene's own id — obsolete ids (from a superseded ScenePlan version) never satisfy the gate. */
  sceneId: string;
  /** The RESOLVED asset's assetGroupId (the version chain root) + the current version's publicId. Null while unresolved. */
  mediaAssetGroupId: string | null;
  mediaAssetPublicId: string | null;
  source: SceneAssetSource | null;
  /** A pending AI generation job for this scene, if any. */
  mediaJobPublicId: string | null;
  failureReason: string | null;
}

export interface AssetStageState {
  status: MediaStageStatus;
  /** Per-scene resolution — computed against the CURRENT ScenePlan every evaluation. Never a single global flag. */
  scenes: AssetSceneRef[];
  /** FR-VID-005: Quality Gate #2 blocks with an itemized list of scenes still missing a resolved asset. */
  missingScenes: string[];
  completedAt: string | null;
  failureReason: string | null;
}

export interface VoiceStageState {
  status: MediaStageStatus;
  /** The current AUDIO media_assets publicId (Gate #3 authority). */
  audioAssetPublicId: string | null;
  /** Object key of the word-timing sidecar JSON in storage. */
  wordTimingObjectKey: string | null;
  /** Hash of the Script version the audio was generated from — Gate #3 fails on mismatch. */
  scriptVersionHash: string | null;
  /** The opaque, provider-neutral catalog id the audio was generated with. */
  voiceProfileId: string | null;
  audioDurationMs: number | null;
  mediaJobPublicId: string | null;
  failureReason: string | null;
}

export interface SubtitleStageState {
  status: MediaStageStatus;
  /** SRT + VTT are two SUBTITLE media_assets. */
  srtAssetPublicId: string | null;
  vttAssetPublicId: string | null;
  /** The audio assetGroupId these subtitles were built against — a new voice version marks them stale. */
  sourceAudioAssetPublicId: string | null;
  cueCount: number | null;
  mediaJobPublicId: string | null;
  failureReason: string | null;
}

/** Module 7 Phase 7.4 — the selected Thumbnail Concept turned into a real image artifact. */
export interface ThumbnailImageStageState {
  status: MediaStageStatus;
  /** Index into the current ThumbnailConceptAgentOutput.concepts[] the user selected. */
  selectedConceptIndex: number | null;
  imageAssetPublicId: string | null;
  imageAssetGroupId: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  mediaJobPublicId: string | null;
  failureReason: string | null;
}

/** A per-scene asset-resolution fact frozen into the render input snapshot (checkpoint §10/§16). */
export interface RenderSnapshotSceneRef {
  sceneId: string;
  assetResolved: boolean;
  /** True once the render worker successfully materialized the private asset for the render. */
  materialized: boolean;
}

export interface RenderStageState {
  status: MediaStageStatus;
  /** VideoRenderJob publicId for the CURRENT submitted render (checkpoint D5) — Phase 7.5. */
  renderJobPublicId: string | null;
  /** The produced VIDEO MediaAsset — Gate #4 authority is this ACTIVE asset, never job status alone. */
  renderedVideoPublicId: string | null;
  renderedVideoAssetGroupId: string | null;
  exportProfileId: string | null;
  /** FR-VID-007: rendering resumes rather than restarts — the attempt counter is retry-limited. */
  attempt: number;
  /** Deterministic timeline total the render targeted (from deriveSceneTimeline). */
  expectedDurationMs: number | null;
  /** Inspected output metadata (ffprobe-equivalent) — populated on success. */
  outputWidth: number | null;
  outputHeight: number | null;
  outputDurationMs: number | null;
  outputChecksumSha256: string | null;
  outputByteSize: number | null;
  /** Freshness fences frozen at submit — Gate #4 currentness (checkpoint §14/§24). */
  scriptVersionHash: string | null;
  sceneAssetFingerprint: string | null;
  voiceAudioAssetPublicId: string | null;
  subtitleVttAssetPublicId: string | null;
  /** Snapshot evidence for QA Missing Assets + Branding. */
  snapshotScenes: RenderSnapshotSceneRef[];
  brandingLayerConfigured: boolean;
  brandingLogoInSnapshot: boolean;
  brandingIntroRequired: boolean;
  brandingIntroRendered: boolean;
  brandingOutroRequired: boolean;
  brandingOutroRendered: boolean;
  completedAt: string | null;
  failureReason: string | null;
}

export interface QaCheckResult {
  id: "missing_assets" | "audio_sync" | "subtitle_sync" | "resolution" | "duration" | "branding";
  label: string;
  passed: boolean;
  explanation: string;
  evidence: string[];
  measured?: number | string | null;
  expected?: number | string | null;
}

export interface QaStageState {
  status: DeterministicStageStatus;
  /** The frozen 6 QA Engine checks (FR-VID-008). */
  checks: QaCheckResult[];
  /** All six PASS — Gate #5. */
  passed: boolean | null;
  /** The render this QA report is bound to — a newer render makes this QA stale (checkpoint §23). */
  renderJobPublicId: string | null;
  renderedVideoPublicId: string | null;
  completedAt: string | null;
}

export interface SeoStageState {
  status: GenerationStageStatus;
  aiJobPublicId: string | null;
  /** Written onto the video_scripts row (meta_title / meta_description / tags / chapters / hashtags / schema_markup). */
  videoScriptPublicId: string | null;
  artifact: VideoSeoMetadataAgentOutput | null;
  failureReason: string | null;
}

/** ADVISORY — never gates review, never invalidated by mandatory-stage regeneration (except its own). */
export interface ThumbnailConceptsStageState {
  status: AdvisoryStageStatus;
  aiJobPublicId: string | null;
  artifact: ThumbnailConceptAgentOutput | null;
  failureReason: string | null;
}

/** ADVISORY — same non-blocking contract as thumbnailConcepts. */
export interface RecommendationsStageState {
  status: AdvisoryStageStatus;
  aiJobPublicId: string | null;
  artifact: VideoRecommendationsAgentOutput | null;
  failureReason: string | null;
}

/**
 * Module 7 Phase 7.3 — mirrors Blog's own `ScoringStageState` exactly:
 * `status` is the FRESHNESS flag, not a job status. PENDING means "no
 * current score" (either never scored, or an upstream artifact was
 * regenerated since the last score — see `claimStage`'s reset rules in
 * video-pipeline-state.ts). COMPLETED means the persisted
 * `contentScorePublicId` genuinely reflects the CURRENT brief/script/
 * scenePlan/seo/thumbnailConcepts. The append-only `content_scores`
 * history is never deleted or edited when this resets — only this
 * pointer moves back to PENDING (checkpoint §14: "freshness/current-
 * version semantics rather than destructive score updates").
 */
export interface ScoreStageState {
  status: DeterministicStageStatus;
  contentScorePublicId: string | null;
  overallScore: number | null;
  /** The Video Score (`ScoreResult.dimension.score` for VIDEO_DIMENSION_V1) — separate from overallScore. */
  videoScore: number | null;
  /** The Thumbnail Score, or null when no Thumbnail Concept existed at scoring time (never fabricated). */
  thumbnailScore: number | null;
  passThreshold: number | null;
  passed: boolean | null;
  ranAt: string | null;
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
  thumbnailConcepts: ThumbnailConceptsStageState;
  /** Module 7 Phase 7.4 — the real thumbnail image derived from a selected concept. Advisory-adjacent: never gates review. */
  thumbnailImage: ThumbnailImageStageState;
  recommendations: RecommendationsStageState;
  score: ScoreStageState;
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

/** The 4 mandatory TEXT generation stages Phase 7.2 actually executes, in dependency order. */
export type TextGenerationStageKey = "brief" | "script" | "scenePlan" | "seo";
/** The 2 advisory TEXT generation stages Phase 7.2 executes — never gate anything. */
export type AdvisoryStageKey = "thumbnailConcepts" | "recommendations";
