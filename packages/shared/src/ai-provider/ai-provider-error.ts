/**
 * Module 3 Phase 3.1 — normalized provider error taxonomy
 * (AI_PROVIDER_ABSTRACTION_LAYER_V1.0.md "Error Handling": Timeout Retry,
 * Rate Limit Backoff, Provider Failover, Structured Error Codes, Audit
 * Logging). `retryable` is a classification only — this layer never
 * retries anything itself (ADR-005: `ai_jobs` is the authoritative async
 * execution layer; retrying here too would compound with whatever future
 * job-layer retry wraps this call). `messageSafe` mirrors
 * PermanentProcessorError's own `errorMessageSafe` discipline: curated
 * text only, never a raw SDK error, stack trace, header dump, or
 * anything that could contain a credential.
 */
export enum AIProviderErrorCode {
  AUTH_CONFIG = "AUTH_CONFIG",
  INVALID_REQUEST = "INVALID_REQUEST",
  RATE_LIMIT = "RATE_LIMIT",
  PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE",
  TIMEOUT = "TIMEOUT",
  TRANSIENT_NETWORK = "TRANSIENT_NETWORK",
  CONTENT_SAFETY_REJECTED = "CONTENT_SAFETY_REJECTED",
  MALFORMED_STRUCTURED_OUTPUT = "MALFORMED_STRUCTURED_OUTPUT",
  UNKNOWN = "UNKNOWN",
}

/** Whether a caller could reasonably expect a retry to succeed — a classification for whatever future layer decides to retry, not an instruction to retry here. */
const RETRYABLE_CODES: ReadonlySet<AIProviderErrorCode> = new Set([
  AIProviderErrorCode.RATE_LIMIT,
  AIProviderErrorCode.PROVIDER_UNAVAILABLE,
  AIProviderErrorCode.TIMEOUT,
  AIProviderErrorCode.TRANSIENT_NETWORK,
]);

export interface AIProviderErrorMetadata {
  /** Seconds the caller should wait before a future retry attempt, when the provider communicated one (e.g. a rate-limit Retry-After header). Advisory only. */
  retryAfterSeconds?: number;
  /** The provider's own request/trace id, when available — for cross-referencing provider-side logs without exposing response bodies. */
  providerRequestId?: string;
  /** The HTTP status code the provider responded with, when this originated from an HTTP-based SDK. */
  httpStatus?: number;
}

export class AIProviderError extends Error {
  constructor(
    public readonly code: AIProviderErrorCode,
    public readonly messageSafe: string,
    public readonly provider: string,
    public readonly metadata: AIProviderErrorMetadata = {},
  ) {
    super(messageSafe);
    this.name = "AIProviderError";
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}
