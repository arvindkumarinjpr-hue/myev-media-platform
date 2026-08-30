/**
 * Module 7 Phase 7.4 — normalized media-provider error taxonomy.
 *
 * The image/TTS analogue of Module 3's `AIProviderError`
 * (ai-provider/ai-provider-error.ts) — same discipline, kept separate
 * because image/TTS providers surface a slightly different failure
 * surface (content moderation refusals, per-image quota, synthesis
 * limits) and because a media adapter must never import the text
 * ai-provider layer.
 *
 * `retryable` is a CLASSIFICATION only. This layer never retries — the
 * MEDIA-queue processor + Module 1F's BullMqWorkerManager own retry
 * scheduling (QUEUE_AND_BACKGROUND_JOB_ENGINE_V1.0.md §7). `messageSafe`
 * mirrors `AIProviderError.messageSafe` / `PermanentProcessorError`'s own
 * `errorMessageSafe` discipline: curated text only — never a raw SDK
 * error, stack trace, header dump, prompt, or anything that could carry a
 * credential.
 */
export enum MediaProviderErrorCode {
  /** Missing/invalid API key or region config — a permanent, deploy-time condition. */
  AUTH_CONFIG = "AUTH_CONFIG",
  /** The request itself is malformed/unsupported (bad aspect ratio, empty text, unknown voice). Permanent. */
  INVALID_REQUEST = "INVALID_REQUEST",
  /** The provider refused on content-policy / moderation grounds. Permanent — a retry of the same input will refuse again. */
  CONTENT_MODERATION = "CONTENT_MODERATION",
  /** Provider rate limit / quota exhaustion. Transient. */
  RATE_LIMIT = "RATE_LIMIT",
  /** Provider 5xx / outage / dependency failure. Transient. */
  PROVIDER_UNAVAILABLE = "PROVIDER_UNAVAILABLE",
  /** The call exceeded the caller's abort budget. Transient. */
  TIMEOUT = "TIMEOUT",
  /** Network-level failure reaching the provider. Transient. */
  TRANSIENT_NETWORK = "TRANSIENT_NETWORK",
  /** The provider returned a response this layer could not normalize into the contract (missing bytes, no timing stream, etc.). Permanent. */
  MALFORMED_RESPONSE = "MALFORMED_RESPONSE",
  UNKNOWN = "UNKNOWN",
}

const RETRYABLE_CODES: ReadonlySet<MediaProviderErrorCode> = new Set([
  MediaProviderErrorCode.RATE_LIMIT,
  MediaProviderErrorCode.PROVIDER_UNAVAILABLE,
  MediaProviderErrorCode.TIMEOUT,
  MediaProviderErrorCode.TRANSIENT_NETWORK,
]);

export interface MediaProviderErrorMetadata {
  /** Seconds to wait before a future retry, when the provider communicated one (Retry-After). Advisory only. */
  retryAfterSeconds?: number;
  /** The provider's own request/trace id, when available — for cross-referencing provider-side logs without exposing bodies. */
  providerRequestId?: string;
  /** The HTTP status the provider responded with, when this originated from an HTTP-based SDK. */
  httpStatus?: number;
}

export class MediaProviderError extends Error {
  constructor(
    public readonly code: MediaProviderErrorCode,
    public readonly messageSafe: string,
    public readonly provider: string,
    public readonly metadata: MediaProviderErrorMetadata = {},
  ) {
    super(messageSafe);
    this.name = "MediaProviderError";
  }

  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }
}
