/**
 * Module 3 Phase 3.2 — Agent-level failure classification. Distinct from
 * (and a superset of the causes of) AIProviderErrorCode: a
 * AgentExecutionResult can fail before a provider is ever called
 * (unknown agent, inactive/wrong-workspace Knowledge Pack, invalid
 * input) — PROVIDER_ERROR is the one case where the underlying cause was
 * an AIProviderError, whose own `code`/`retryable` is preserved in
 * `AgentExecutionFailure.providerErrorCode`/`retryable` rather than
 * re-encoded here.
 */
export enum AgentExecutionErrorCode {
  UNKNOWN_AGENT = "UNKNOWN_AGENT",
  // Covers both "no such Knowledge Pack" and "exists, but in a different
  // workspace" — deliberately not distinguished, mirroring
  // KnowledgePacksService.findOne's own enumeration-safe NotFoundException
  // (a caller must never be able to tell the two apart).
  KNOWLEDGE_PACK_NOT_FOUND = "KNOWLEDGE_PACK_NOT_FOUND",
  KNOWLEDGE_PACK_NOT_ACTIVE = "KNOWLEDGE_PACK_NOT_ACTIVE",
  INPUT_VALIDATION_FAILED = "INPUT_VALIDATION_FAILED",
  PROVIDER_ERROR = "PROVIDER_ERROR",
  TIMED_OUT = "TIMED_OUT",
  // Module 3 Phase 3.5 — distinct from PROVIDER_ERROR (an attempted call
  // that failed): this agent's own providerPreference names a provider
  // id the current process's AIProviderRegistry never registered (e.g.
  // its credentials aren't configured in this environment). A resolver
  // boundary fix — previously an unconfigured provider threw an
  // unhandled exception past the point an ai_jobs row already existed,
  // leaving it stuck RUNNING forever (see AgentExecutionResolutionError).
  PROVIDER_NOT_CONFIGURED = "PROVIDER_NOT_CONFIGURED",
}

/**
 * `messageSafe` mirrors AIProviderError's own discipline: curated text
 * only, never a raw stack trace, class-validator violation object, or
 * provider SDK detail.
 */
export interface AgentExecutionFailure {
  code: AgentExecutionErrorCode;
  messageSafe: string;
  /** Set only when code === PROVIDER_ERROR — the underlying AIProviderErrorCode, preserved rather than re-encoded. */
  providerErrorCode?: string;
  /** Set only when code === PROVIDER_ERROR — mirrors AIProviderError.retryable, for a future durable-dispatch caller's own retry decision. Never acted on by the AgentExecutor itself (ADR-005). */
  retryable?: boolean;
}
