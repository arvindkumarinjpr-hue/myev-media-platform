import type { BlogListItem, BlogPipeline, BlogPipelineStage } from "../../lib/types";
import { PIPELINE_STEPS } from "./blogLabels";

/**
 * Which pipeline step the article is currently on — derived from the read
 * model, never a stored value, never a percentage. Mirrors the backend's
 * own `deriveStage` ordering so the stepper and the list agree.
 */
export function deriveStage(p: BlogPipeline): BlogPipelineStage {
  if (p.contentItem.status === "APPROVED") return "PUBLISH_READY";
  if (p.contentItem.status === "REVIEW") return "IN_REVIEW";
  if (p.brief.status !== "APPROVED") return "BRIEF";
  if (p.outline.status !== "APPROVED") return "OUTLINE";
  if (p.draft.status !== "READY") return "DRAFT";
  if (p.seo.status !== "READY") return "SEO";
  if (p.internalLinking.status !== "COMPLETED") return "INTERNAL_LINKING";
  if (p.qa.status !== "COMPLETED") return "QA";
  if (p.scoring.status !== "COMPLETED" || p.scoring.passed !== true) return "SCORING";
  return "READY_FOR_REVIEW";
}

/** Same derivation from the compact list payload. */
export function deriveListStage(b: BlogListItem): BlogPipelineStage {
  if (b.status === "APPROVED") return "PUBLISH_READY";
  if (b.status === "REVIEW") return "IN_REVIEW";
  if (b.brief !== "APPROVED") return "BRIEF";
  if (b.outline !== "APPROVED") return "OUTLINE";
  if (b.draft !== "READY") return "DRAFT";
  if (b.seo !== "READY") return "SEO";
  if (b.qa !== "COMPLETED") return "QA";
  if (b.scoring.status !== "COMPLETED" || b.scoring.passed !== true) return "SCORING";
  return "READY_FOR_REVIEW";
}

export type StepState = "pending" | "running" | "ready" | "done" | "failed";

/** Per-step state for the stepper's own status treatment. */
export function stepStates(p: BlogPipeline): Record<(typeof PIPELINE_STEPS)[number]["id"], StepState> {
  const gen = (status: BlogPipeline["brief"]["status"], approvable: boolean): StepState => {
    if (status === "FAILED") return "failed";
    if (status === "GENERATING") return "running";
    if (status === "APPROVED") return "done";
    if (status === "READY") return approvable ? "ready" : "done";
    return "pending";
  };
  return {
    brief: gen(p.brief.status, true),
    outline: gen(p.outline.status, true),
    draft: gen(p.draft.status, false),
    seo: gen(p.seo.status, false),
    internalLinking: p.internalLinking.status === "COMPLETED" ? "done" : "pending",
    qa: p.qa.status === "COMPLETED" ? "done" : "pending",
    scoring:
      p.scoring.status === "COMPLETED" ? (p.scoring.passed ? "done" : "failed") : "pending",
    review:
      p.contentItem.status === "APPROVED" ? "done" : p.contentItem.status === "REVIEW" ? "running" : "pending",
  };
}

/** Index of the current step for the <Stepper current={…} />. */
export function currentStepIndex(p: BlogPipeline): number {
  const states = stepStates(p);
  const order = PIPELINE_STEPS.map((s) => s.id);
  const firstUnfinished = order.findIndex((id) => states[id] !== "done");
  return firstUnfinished === -1 ? order.length - 1 : firstUnfinished;
}
