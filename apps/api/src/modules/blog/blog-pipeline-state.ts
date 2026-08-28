import { BLOG_PIPELINE_METADATA_KEY, type BlogPipelineStage, type BlogPipelineState } from "./blog-pipeline.types";

/**
 * Module 6 Phase 6.3 — pure helpers over the pipeline state blob. No I/O,
 * no NestJS. The one place the `content_items.metadata.blogPipeline`
 * shape is read, defaulted, and reduced to a coarse stage label + the
 * publish-ready flag. Everything here is deterministic and unit-tested in
 * isolation (blog-pipeline-state.spec.ts).
 */

export function emptyPipelineState(knowledgePackVersionId: string): BlogPipelineState {
  return {
    knowledgePackVersionId,
    brief: { status: "PENDING", aiJobPublicId: null, artifact: null, approvedAt: null, approvedByUserPublicId: null, failureReason: null },
    outline: { status: "PENDING", aiJobPublicId: null, artifact: null, approvedAt: null, approvedByUserPublicId: null, failureReason: null },
    draft: { status: "PENDING", aiJobPublicId: null, contentVersionPublicId: null, artifact: null, failureReason: null },
    seo: { status: "PENDING", aiJobPublicId: null, blogArticlePublicId: null, artifact: null, failureReason: null },
    internalLinking: { status: "PENDING", suggestions: [], reason: "engine_not_available", completedAt: null },
    qa: { status: "PENDING", checks: [], completedAt: null },
    scoring: { status: "PENDING", contentScorePublicId: null, overallScore: null, passThreshold: null, passed: null, ranAt: null },
  };
}

/**
 * Reads the pipeline state out of a content item's metadata bag. Returns
 * null when the item was never started as a Blog pipeline (a plain
 * Module 1E blog content item) — callers turn that into
 * BLOG_NOT_A_PIPELINE_ITEM.
 */
export function readPipelineState(metadata: unknown): BlogPipelineState | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>)[BLOG_PIPELINE_METADATA_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as Partial<BlogPipelineState>;
  if (typeof state.knowledgePackVersionId !== "string") return null;
  // Merge onto a fresh skeleton so a state written by an older shape can
  // never surface `undefined` for a stage the current code reads.
  const base = emptyPipelineState(state.knowledgePackVersionId);
  return {
    knowledgePackVersionId: state.knowledgePackVersionId,
    brief: { ...base.brief, ...state.brief },
    outline: { ...base.outline, ...state.outline },
    draft: { ...base.draft, ...state.draft },
    seo: { ...base.seo, ...state.seo },
    internalLinking: { ...base.internalLinking, ...state.internalLinking },
    qa: { ...base.qa, ...state.qa },
    scoring: { ...base.scoring, ...state.scoring },
  };
}

/**
 * Writes the pipeline state back into a metadata bag, preserving every
 * other key an operator or Module 1E may have set on the same item.
 */
export function writePipelineState(metadata: unknown, state: BlogPipelineState): Record<string, unknown> {
  const bag = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? { ...(metadata as Record<string, unknown>) } : {};
  bag[BLOG_PIPELINE_METADATA_KEY] = state;
  return bag;
}

/** Every generation + deterministic gate the human-review handoff requires, per BLOG_AUTOMATION_ENGINE_V1.0 "Quality Gates". */
export function unmetReviewGates(state: BlogPipelineState): string[] {
  const gates: string[] = [];
  if (state.brief.status !== "APPROVED") gates.push("brief_approved");
  if (state.outline.status !== "APPROVED") gates.push("outline_approved");
  if (state.draft.status !== "READY" || !state.draft.contentVersionPublicId) gates.push("draft_generated");
  if (state.seo.status !== "READY") gates.push("seo_complete");
  if (state.internalLinking.status !== "COMPLETED") gates.push("internal_links_added");
  if (state.qa.status !== "COMPLETED") gates.push("qa_complete");
  if (state.scoring.status !== "COMPLETED") gates.push("content_score_run");
  else if (state.scoring.passed !== true) gates.push("content_score_passed");
  return gates;
}

/**
 * Coarse "where is it" label for the read model — derived from stage
 * statuses + the content item's own lifecycle status, never stored as a
 * source of truth. `itemStatus` is the Module 1E ContentItemStatus.
 */
export function deriveStage(state: BlogPipelineState, itemStatus: string): BlogPipelineStage {
  if (itemStatus === "APPROVED") return "PUBLISH_READY";
  if (itemStatus === "REVIEW") return "IN_REVIEW";
  if (state.brief.status !== "APPROVED") return "BRIEF";
  if (state.outline.status !== "APPROVED") return "OUTLINE";
  if (state.draft.status !== "READY") return "DRAFT";
  if (state.seo.status !== "READY") return "SEO";
  if (state.internalLinking.status !== "COMPLETED") return "INTERNAL_LINKING";
  if (state.qa.status !== "COMPLETED") return "QA";
  if (state.scoring.status !== "COMPLETED" || state.scoring.passed !== true) return "SCORING";
  return "READY_FOR_REVIEW";
}

/** §24.5: "Publish Ready" is the gate label for an APPROVED blog content item — never publishing itself. */
export function isPublishReady(itemStatus: string): boolean {
  return itemStatus === "APPROVED";
}
