/**
 * Module 3 Phase 3.2 — the provider-neutral Agent execution request.
 * `knowledgePackVersionId` is always the EXACT Knowledge Pack version's
 * public id — never "the workspace's active pack", resolved implicitly.
 * The caller (a future business module) is responsible for deciding
 * which version it wants an agent to run against; the AgentExecutor only
 * ever resolves and validates the version it was actually given (Part 5's
 * "never dynamically substitute latest active behind the caller's back").
 */
export interface AgentExecutionRequest {
  agentIdentifier: string;
  /** Omitted resolves the highest registered version deterministically (see AgentRegistry.resolve) — the result always records exactly which version ran. */
  agentVersion?: number;

  workspaceId: string;
  knowledgePackVersionId: string;

  /** Validated against the resolved AgentDefinition's own inputSchema before execution proceeds. */
  input: Record<string, unknown>;

  correlationId: string;
  /** The id of whatever upstream event/request caused this execution, when one exists — audit/observability metadata only. */
  causationId?: string;

  /** Present only when a real user/API caller triggered this execution — absent for a genuine system-triggered one (mirrors AiJob.createdById's own nullability). */
  requestedByUserId?: string;

  metadata?: Record<string, unknown>;
}
