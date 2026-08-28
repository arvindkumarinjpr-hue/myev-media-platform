/**
 * Module 6 Phase 6.3 — Blog pipeline business error codes.
 *
 * Every code here maps to a real frozen-workflow gate (BLOG_AUTOMATION_
 * ENGINE_V1.0.md "Quality Gates", FRD FR-BLOG-001..008 "Error
 * Conditions", §24.5 Blog lifecycle). No code is added that isn't
 * actually thrown by a gate below. The shape ({ code, message }) matches
 * the codebase-wide convention every other module's Nest exceptions use.
 */
export const BLOG_ERRORS = {
  // Create / brief
  BLOG_TOPIC_REQUIRED: "BLOG_TOPIC_REQUIRED",
  BLOG_KNOWLEDGE_PACK_NOT_ACTIVE: "BLOG_KNOWLEDGE_PACK_NOT_ACTIVE",
  BLOG_BRIEF_NOT_READY: "BLOG_BRIEF_NOT_READY",
  BLOG_BRIEF_NOT_APPROVED: "BLOG_BRIEF_NOT_APPROVED",
  // Outline
  BLOG_OUTLINE_NOT_READY: "BLOG_OUTLINE_NOT_READY",
  BLOG_OUTLINE_NOT_APPROVED: "BLOG_OUTLINE_NOT_APPROVED",
  // Draft / SEO
  BLOG_DRAFT_NOT_READY: "BLOG_DRAFT_NOT_READY",
  BLOG_SEO_NOT_READY: "BLOG_SEO_NOT_READY",
  // Internal linking / QA / score
  BLOG_INTERNAL_LINKING_NOT_COMPLETE: "BLOG_INTERNAL_LINKING_NOT_COMPLETE",
  BLOG_QA_NOT_COMPLETE: "BLOG_QA_NOT_COMPLETE",
  SEO_SCORE_NOT_RUN: "SEO_SCORE_NOT_RUN",
  SEO_SCORE_BELOW_THRESHOLD: "SEO_SCORE_BELOW_THRESHOLD",
  // Pipeline mechanics
  BLOG_STAGE_ALREADY_RUNNING: "BLOG_STAGE_ALREADY_RUNNING",
  BLOG_STAGE_AI_OUTPUT_INVALID: "BLOG_STAGE_AI_OUTPUT_INVALID",
  BLOG_PIPELINE_ITEM_NOT_EDITABLE: "BLOG_PIPELINE_ITEM_NOT_EDITABLE",
  BLOG_NOT_A_PIPELINE_ITEM: "BLOG_NOT_A_PIPELINE_ITEM",
} as const;

export type BlogErrorCode = (typeof BLOG_ERRORS)[keyof typeof BLOG_ERRORS];
