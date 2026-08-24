/**
 * Module 3 Phase 3.2 — the exact, frozen status vocabulary
 * (AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §24.8 / §5.5 `ai_jobs`).
 * Deliberately identical to the Prisma `AiJobStatus` enum — this is the
 * provider-neutral (non-Prisma-dependent) mirror used throughout
 * @myev/shared and the Agent Framework contracts, never redefined with
 * different names/values.
 */
export type AgentExecutionStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMED_OUT";
