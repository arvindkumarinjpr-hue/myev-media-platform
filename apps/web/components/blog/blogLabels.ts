import type { BadgeTone } from "../ui/Badge";
import type {
  BlogDeterministicStageStatus,
  BlogGenerationStageStatus,
  BlogPipelineStage,
  BlogQaCheckId,
  BlogReviewGate,
  ContentItemStatus,
} from "../../lib/types";

export const GENERATION_STAGE_STATUS: Record<BlogGenerationStageStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  PENDING: { label: "Not started", tone: "neutral" },
  GENERATING: { label: "Generating", tone: "warning", dot: true },
  READY: { label: "Ready", tone: "info" },
  APPROVED: { label: "Approved", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
};

export const DETERMINISTIC_STAGE_STATUS: Record<BlogDeterministicStageStatus, { label: string; tone: BadgeTone }> = {
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

export const PIPELINE_STAGE_LABEL: Record<BlogPipelineStage, string> = {
  BRIEF: "Brief",
  OUTLINE: "Outline",
  DRAFT: "Draft",
  SEO: "SEO",
  INTERNAL_LINKING: "Internal linking",
  QA: "Quality assurance",
  SCORING: "Content score",
  READY_FOR_REVIEW: "Ready for review",
  IN_REVIEW: "In review",
  APPROVED: "Approved",
  PUBLISH_READY: "Publish ready",
};

/** The ordered pipeline steps for the stepper (the 8 workflow stages, not the derived terminal labels). */
export const PIPELINE_STEPS = [
  { id: "brief", label: "Brief" },
  { id: "outline", label: "Outline" },
  { id: "draft", label: "Draft" },
  { id: "seo", label: "SEO" },
  { id: "internalLinking", label: "Internal linking" },
  { id: "qa", label: "QA" },
  { id: "scoring", label: "Score" },
  { id: "review", label: "Review" },
] as const;

export const QA_CHECK_LABEL: Record<BlogQaCheckId, string> = {
  grammar: "Grammar",
  readability: "Readability",
  structure_headings: "Structure & headings",
  keyword_stuffing: "Keyword stuffing",
  duplicate_content: "Duplicate content",
  brand_compliance: "Brand compliance",
};

export const REVIEW_GATE_LABEL: Record<BlogReviewGate, string> = {
  brief_approved: "Approve the brief",
  outline_approved: "Approve the outline",
  draft_generated: "Generate the draft",
  seo_complete: "Complete the SEO pass",
  internal_linking_completed: "Complete the internal-linking stage",
  qa_complete: "Run quality assurance",
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

/**
 * User-facing copy for a failed AI stage. The backend's `failureReason`
 * is already a safe, curated string (never a stack trace); a few known
 * codes get clearer wording.
 */
export function stageFailureExplanation(failureReason: string | null): string {
  const reason = failureReason?.trim() ?? "";
  if (/PROVIDER_NOT_CONFIGURED/i.test(reason)) {
    return "The AI provider for this stage isn't configured for this workspace yet. Ask an administrator to connect one, then regenerate.";
  }
  if (/KNOWLEDGE_PACK_NOT_ACTIVE/i.test(reason)) {
    return "The Knowledge Pack this article is bound to is no longer active. Activate it (or its version) and regenerate.";
  }
  if (/schema validation/i.test(reason)) {
    return "The AI returned output that didn't match the expected shape for this stage. Regenerate to try again.";
  }
  if (/TIMED_OUT/i.test(reason)) {
    return "This stage took too long and was stopped. Regenerate to try again.";
  }
  return reason || "This stage didn't complete successfully. Regenerate to try again.";
}
