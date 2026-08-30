import type { BadgeTone } from "../ui/Badge";
import type {
  ContentItemStatus,
  VideoAdvisoryStageStatus,
  VideoDeterministicStageStatus,
  VideoGenerationStageStatus,
  VideoMediaStageStatus,
  VideoPipelineStage,
  VideoQaCheckId,
  VideoReviewGate,
  VideoTargetPlatform,
} from "../../lib/types";

/** The frozen 8 Quality Gates (VIDEO_AUTOMATION_ENGINE_V1.0.md) — the stepper's spine. */
export const VIDEO_GATES = [
  { id: "script_approved", label: "Script Approved" },
  { id: "assets_available", label: "Assets Available" },
  { id: "voice_generated", label: "Voice Generated" },
  { id: "rendering_successful", label: "Rendering Successful" },
  { id: "qa_passed", label: "QA Passed" },
  { id: "seo_complete", label: "SEO Complete" },
  { id: "human_approval", label: "Human Approval" },
  { id: "publish_ready", label: "Publish Ready" },
] as const;
export type VideoGateId = (typeof VIDEO_GATES)[number]["id"];

export const TARGET_PLATFORM_LABEL: Record<VideoTargetPlatform, string> = {
  YOUTUBE_LONG: "YouTube — long-form (1920×1080)",
  YOUTUBE_SHORTS: "YouTube Shorts (1080×1920)",
  INSTAGRAM_REEL: "Instagram Reel (1080×1920)",
  FACEBOOK_REEL: "Facebook Reel (1080×1920)",
  SQUARE_SOCIAL: "Square social (1080×1080)",
  LANDSCAPE_PRESENTATION: "Landscape presentation (1920×1080)",
};

export const GENERATION_STAGE_STATUS: Record<VideoGenerationStageStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  PENDING: { label: "Not started", tone: "neutral" },
  GENERATING: { label: "Generating", tone: "warning", dot: true },
  READY: { label: "Ready", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
};

export const ADVISORY_STAGE_STATUS: Record<VideoAdvisoryStageStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  PENDING: { label: "Not started", tone: "neutral" },
  GENERATING: { label: "Generating", tone: "warning", dot: true },
  READY: { label: "Ready", tone: "info" },
  FAILED: { label: "Failed", tone: "danger" },
};

export const MEDIA_STAGE_STATUS: Record<VideoMediaStageStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  PENDING: { label: "Not started", tone: "neutral" },
  RUNNING: { label: "In progress", tone: "warning", dot: true },
  READY: { label: "Ready", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
};

export const DETERMINISTIC_STAGE_STATUS: Record<VideoDeterministicStageStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "Not started", tone: "neutral" },
  COMPLETED: { label: "Complete", tone: "success" },
};

export const CONTENT_ITEM_STATUS: Record<ContentItemStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  IN_PROGRESS: { label: "In progress", tone: "info", dot: true },
  REVIEW: { label: "In review", tone: "warning", dot: true },
  APPROVED: { label: "Approved", tone: "success" },
  SCHEDULED: { label: "Scheduled", tone: "info" },
  PUBLISHED: { label: "Published", tone: "success" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
  DELETED: { label: "Deleted", tone: "neutral" },
  RENDERING: { label: "Rendering", tone: "info", dot: true },
  FAILED: { label: "Failed", tone: "danger" },
};

export const PIPELINE_STAGE_LABEL: Record<VideoPipelineStage, string> = {
  BRIEF: "Brief",
  SCRIPT: "Script",
  SCENE_PLAN: "Scene plan",
  ASSETS: "Assets",
  VOICE: "Voice",
  SUBTITLES: "Subtitles",
  RENDER: "Render",
  QA: "Quality assurance",
  SEO: "SEO",
  READY_FOR_REVIEW: "Ready for review",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
  PUBLISH_READY: "Publish ready",
};

export const QA_CHECK_LABEL: Record<VideoQaCheckId, string> = {
  missing_assets: "Missing assets",
  audio_sync: "Audio sync",
  subtitle_sync: "Subtitle sync",
  resolution: "Resolution",
  duration: "Duration",
  branding: "Branding",
};

export const REVIEW_GATE_LABEL: Record<VideoReviewGate, string> = {
  script_approved: "Approve the script (Gate #1)",
  assets_available: "Resolve every scene's asset (Gate #2)",
  voice_generated: "Generate the narration (Gate #3)",
  rendering_successful: "Produce a successful render (Gate #4)",
  qa_passed: "Pass all six QA checks (Gate #5)",
  seo_complete: "Complete the SEO pass (Gate #6)",
  human_approval: "Human approval (Gate #7)",
  publish_ready: "Publish ready (Gate #8)",
  content_score_run: "Run the content score",
  content_score_passed: "Reach the passing content score",
};

export const SCORE_CATEGORY_LABEL: Record<string, string> = {
  SEO: "SEO",
  VIRAL: "Viral",
  QUALITY: "Quality",
  ENGAGEMENT: "Engagement",
  BUSINESS: "Business",
};

/** The subset the render pipeline actually renders — the rest degrade to a hard cut. */
export const RENDERED_TRANSITIONS = ["cut", "fade", "dissolve"] as const;

/**
 * User-facing copy for a failed stage. The backend's `failureReason` is
 * already a safe curated string (never a stack trace); a few known
 * shapes get clearer wording.
 */
export function stageFailureExplanation(failureReason: string | null | undefined): string {
  const reason = failureReason?.trim() ?? "";
  if (/PROVIDER_NOT_CONFIGURED|provider.*not.*configured|no (openai|azure)/i.test(reason)) {
    return "The media/AI provider for this stage isn't configured for this workspace yet. Ask an administrator to connect one, then regenerate.";
  }
  if (/KNOWLEDGE_PACK_NOT_ACTIVE/i.test(reason)) {
    return "The Knowledge Pack this video is bound to is no longer active. Activate it (or its version) and regenerate.";
  }
  if (/script changed since voice/i.test(reason)) {
    return "The script changed after this narration was generated. Regenerate the voice so it matches the current script.";
  }
  if (/voice was regenerated|rebuild subtitles/i.test(reason)) {
    return "The narration was regenerated. Rebuild the subtitles so their timing matches the new audio.";
  }
  if (/checksum|output VIDEO asset is missing/i.test(reason)) {
    return "The render finished but its output video couldn't be verified. Re-submit the render.";
  }
  if (/schema validation|didn't match the expected shape/i.test(reason)) {
    return "The AI returned output that didn't match the expected shape for this stage. Regenerate to try again.";
  }
  if (/TIMED_OUT|took too long/i.test(reason)) {
    return "This stage took too long and was stopped. Regenerate to try again.";
  }
  return reason || "This stage didn't complete successfully. Regenerate to try again.";
}

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}
