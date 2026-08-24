import type { AITokenUsage } from "../ai-provider/ai-response";
import type { AgentExecutionFailure } from "./agent-execution-error";
import type { AgentExecutionStatus } from "./agent-execution-status";

/**
 * Module 3 Phase 3.2 — the provider-neutral Agent execution result.
 * Always carries `knowledgePackVersionUsed`/`agentVersionUsed` — exact
 * execution provenance, reproducible regardless of what "latest" meant
 * at request time (Part 4/9's reproducibility requirement).
 */
export interface AgentExecutionResult {
  status: AgentExecutionStatus;

  /** Present only when status === "COMPLETED". Schema-validated object when the agent defines an outputSchema, plain text otherwise — never a raw unvalidated string in the structured case (Phase 3.1's structured-output.ts guarantee, carried through here). */
  output?: string | Record<string, unknown>;

  /** Present once a provider call was actually attempted — absent for a failure that occurred before provider resolution (e.g. UNKNOWN_AGENT). */
  providerUsed?: string;
  modelUsed?: string;
  tokenUsage?: AITokenUsage;
  costEstimate?: number;

  latencyMs: number;

  /** Present only when status === "FAILED" or "TIMED_OUT". */
  failure?: AgentExecutionFailure;

  knowledgePackVersionUsed: string;
  agentIdentifierUsed: string;
  agentVersionUsed: number;

  correlationId: string;
}
