/**
 * Module 7 Phase 7.1 — Video pipeline business error codes.
 *
 * Every code here maps to a real frozen-workflow rule (VIDEO_AUTOMATION_
 * ENGINE_V1.0.md "Quality Gates", FRD FR-VID-001..009 "Error
 * Conditions", §24.6 Video lifecycle). Phase 7.1 only actually throws the
 * create-time and pipeline-mechanics codes; the per-gate codes are
 * declared now (checkpoint §8 "future stage contracts") and wired in
 * Phases 7.2–7.5. The shape ({ code, message }) matches the codebase-wide
 * convention.
 */
export const VIDEO_ERRORS = {
  // Create
  VIDEO_TOPIC_REQUIRED: "VIDEO_TOPIC_REQUIRED",
  VIDEO_TARGET_PLATFORM_REQUIRED: "VIDEO_TARGET_PLATFORM_REQUIRED",
  VIDEO_KNOWLEDGE_PACK_NOT_ACTIVE: "VIDEO_KNOWLEDGE_PACK_NOT_ACTIVE",
  // Pipeline mechanics
  VIDEO_PIPELINE_ITEM_NOT_EDITABLE: "VIDEO_PIPELINE_ITEM_NOT_EDITABLE",
  VIDEO_NOT_A_PIPELINE_ITEM: "VIDEO_NOT_A_PIPELINE_ITEM",
  // Module 7 Phase 7.2 — generation-stage mechanics (mirrors Blog's
  // BLOG_STAGE_ALREADY_RUNNING / BLOG_STAGE_AI_OUTPUT_INVALID).
  VIDEO_STAGE_ALREADY_RUNNING: "VIDEO_STAGE_ALREADY_RUNNING",
  VIDEO_STAGE_AI_OUTPUT_INVALID: "VIDEO_STAGE_AI_OUTPUT_INVALID",
  // Quality Gates (Phases 7.2–7.5)
  VIDEO_BRIEF_NOT_READY: "VIDEO_BRIEF_NOT_READY",
  VIDEO_SCRIPT_NOT_READY: "VIDEO_SCRIPT_NOT_READY",
  VIDEO_SCRIPT_NOT_APPROVED: "VIDEO_SCRIPT_NOT_APPROVED",
  VIDEO_SCENE_PLAN_NOT_READY: "VIDEO_SCENE_PLAN_NOT_READY",
  VIDEO_ASSETS_NOT_AVAILABLE: "VIDEO_ASSETS_NOT_AVAILABLE",
  VIDEO_VOICE_NOT_GENERATED: "VIDEO_VOICE_NOT_GENERATED",
  VIDEO_RENDER_NOT_SUCCESSFUL: "VIDEO_RENDER_NOT_SUCCESSFUL",
  VIDEO_QA_NOT_PASSED: "VIDEO_QA_NOT_PASSED",
  VIDEO_SEO_NOT_COMPLETE: "VIDEO_SEO_NOT_COMPLETE",
} as const;

export type VideoErrorCode = (typeof VIDEO_ERRORS)[keyof typeof VIDEO_ERRORS];
