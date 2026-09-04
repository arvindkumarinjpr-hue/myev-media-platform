import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import type {
  PublishingChannelCapabilities,
  PublishingChannelProvider,
  PublishingConnectionCheckInput,
  PublishingConnectionValidationResult,
  PublishingExecutionCallbacks,
  PublishingPublishInput,
  PublishingPublishResult,
} from "../publishing-provider.interface";
import { parseYouTubeCredential, type YouTubeCredentialPayload } from "./youtube-credential";
import { refreshYouTubeAccessToken, YouTubeOAuthRefreshError, type YouTubeOAuthClientOptions } from "./youtube-oauth-client";

const DEFAULT_API_BASE_URL = "https://www.googleapis.com/youtube/v3";
const DEFAULT_UPLOAD_BASE_URL = "https://www.googleapis.com/upload/youtube/v3";
const DEFAULT_TIMEOUT_MS = 30_000;
// A conservative default: few enough HTTP round-trips to be efficient,
// small enough that this connector's own memory usage stays bounded
// regardless of the underlying video's size (Part N — never buffer the
// whole object). A multiple of YouTube's own recommended 256 KiB
// resumable-upload chunk granularity.
const DEFAULT_CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface YouTubeChannelProviderOptions {
  oauthClientId: string;
  oauthClientSecret: string;
  timeoutMs?: number;
  chunkSizeBytes?: number;
  /** Test-only overrides — never the production default (Part R: fixed, non-user-configurable official endpoints). */
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  oauthTokenEndpoint?: string;
}

/** The non-secret, resumable-upload checkpoint this connector persists via `PublishingExecutionCallbacks.saveCheckpoint()` — see that method's own doc comment. Never contains credentials. */
interface YouTubeUploadCheckpoint {
  uploadSessionUri: string;
  totalBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isYouTubeUploadCheckpoint(value: unknown): value is YouTubeUploadCheckpoint {
  return isRecord(value) && typeof value.uploadSessionUri === "string" && value.uploadSessionUri.length > 0 && typeof value.totalBytes === "number";
}

function parseNextOffsetFromRange(rangeHeader: string | null): number {
  // Google's own resumable-upload guide: a 308 response's `Range` header
  // reports bytes already received, e.g. "bytes=0-1048575" — resume at
  // the byte immediately after. No header at all means nothing has been
  // received yet.
  const match = rangeHeader ? /bytes=\d+-(\d+)/.exec(rangeHeader) : null;
  return match ? parseInt(match[1], 10) + 1 : 0;
}

/**
 * Module 9 Phase 9.5 — the second real PublishingChannelProvider.
 * Framework-free (no NestJS, no Prisma) — mirrors WordPressChannelProvider's
 * own shape and conventions. Uses the global `fetch` directly (Part R —
 * Google's own fixed API/OAuth hosts are never user-configured, so the
 * DNS-rebinding-safe transport WordPress needs for an arbitrary
 * workspace-configured siteUrl does not apply here).
 *
 * Never queries Prisma, never touches storage credentials, and never
 * knows about `MediaAsset`'s storage shape — bytes are read exclusively
 * through the caller-supplied `PublishingExecutionCallbacks.mediaReader`
 * (bounded, chunked reads only — this class never buffers a whole video
 * in memory). Refreshed OAuth tokens and resumable-upload session state
 * are reported back to the caller via `saveCheckpoint`/`onCredentialRefreshed`
 * — this class never persists anything itself.
 *
 * Every outbound call to the plain YouTube Data API or the resumable-
 * upload endpoint goes through `requestAuthenticated()`, which reactively
 * refreshes the access token and retries EXACTLY ONCE on a 401 — the one
 * place OAuth refresh actually happens for `publish()` (which, unlike
 * `validateConnection()`, has no `tokenExpiresAt` hint to pre-check).
 */
export class YouTubeChannelProvider implements PublishingChannelProvider {
  readonly channelType = "YOUTUBE" as const;

  private readonly oauth: YouTubeOAuthClientOptions;
  private readonly timeoutMs: number;
  private readonly chunkSizeBytes: number;
  private readonly apiBaseUrl: string;
  private readonly uploadBaseUrl: string;

  constructor(options: YouTubeChannelProviderOptions) {
    this.oauth = { clientId: options.oauthClientId, clientSecret: options.oauthClientSecret, tokenEndpoint: options.oauthTokenEndpoint, timeoutMs: options.timeoutMs };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.chunkSizeBytes = options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES;
    this.apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.uploadBaseUrl = options.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE_URL;
  }

  getCapabilities(): PublishingChannelCapabilities {
    return {
      supportedContentTypes: ["VIDEO"],
      requiresRenderedMedia: true,
      requiresTitle: true,
      // YouTube's own API does not require a description — a real,
      // official constraint, not a guess (Part H: "do not invent
      // unsupported format limits").
      requiresDescription: false,
      // Module 7's Video SEO stage (VideoScript.tags) genuinely produces
      // tags — unlike WordPress's Blog pipeline, which has no
      // category/tag field at all. Truthful, not invented.
      supportsTags: true,
      // YouTube has no separate "caption" concept distinct from its own
      // description field (Part H) — never mapped.
      supportsCaption: false,
      supportedPrivacyOptions: ["PRIVATE", "UNLISTED", "PUBLIC"],
    };
  }

  async validateConnection(input: PublishingConnectionCheckInput, callbacks?: PublishingExecutionCallbacks): Promise<PublishingConnectionValidationResult> {
    const credential = parseYouTubeCredential(input.decryptedCredential);
    if (!credential) {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Stored YouTube credential is missing required fields." };
    }

    try {
      // Proactive refresh when the stored expiry already says the token
      // is dead — an optimization only, saving a doomed round trip;
      // requestAuthenticated's own reactive-on-401 refresh covers every
      // other case (a missing/wrong/clock-skewed expiry hint).
      if (input.tokenExpiresAt && input.tokenExpiresAt.getTime() <= Date.now()) {
        await this.performRefresh(credential, callbacks);
      }
      // channels.list(mine=true) — a minimal, always-available read call
      // (no plugin/extra scope beyond youtube.upload — Part E) that
      // simultaneously proves the token is valid, the required scope is
      // sufficient, and a real channel is reachable. Never creates or
      // uploads anything during validation (Part P).
      const { status, json } = await this.requestAuthenticated("GET", `${this.apiBaseUrl}/channels?part=snippet&mine=true`, credential, callbacks);
      if (status === 200 && isRecord(json) && Array.isArray(json.items) && json.items.length > 0) {
        return { healthy: true };
      }
      if (status === 200) {
        return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The authenticated Google account has no accessible YouTube channel." };
      }
      if (status === 401) return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "YouTube rejected the credential (unauthorized)." };
      if (status === 403) return this.classifyForbiddenAsConnectionResult(json);
      return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: `Unexpected YouTube response (HTTP ${status}).` };
    } catch (err) {
      if (err instanceof YouTubeOAuthRefreshError) {
        if (err.reasonCode === "REFRESH_TOKEN_REVOKED") return { healthy: false, reasonCode: "CREDENTIAL_REVOKED", detail: "The stored YouTube refresh token is no longer valid." };
        return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: "Could not refresh the YouTube access token (transient)." };
      }
      return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: "YouTube unreachable or timed out." };
    }
  }

  async publish(input: PublishingPublishInput, decryptedCredential: Record<string, unknown>, callbacks?: PublishingExecutionCallbacks): Promise<PublishingPublishResult> {
    const credential = parseYouTubeCredential(decryptedCredential);
    if (!credential) {
      throw new PublishingProviderPermanentError("YOUTUBE_CREDENTIAL_INVALID", "Stored YouTube credential is missing required fields.");
    }
    if (input.contentType !== "VIDEO") {
      throw new PublishingProviderPermanentError("YOUTUBE_UNSUPPORTED_CONTENT_TYPE", `YouTube does not support publishing content type "${input.contentType}".`);
    }
    if (!input.artifact) {
      throw new PublishingProviderPermanentError("YOUTUBE_ARTIFACT_MISSING", "No resolved video artifact was provided to publish.");
    }
    if (!input.metadata.title) {
      throw new PublishingProviderPermanentError("YOUTUBE_TITLE_MISSING", "A title is required to publish to YouTube.");
    }
    if (!callbacks?.mediaReader) {
      // A programmer/wiring error (the caller failed to supply a media
      // reader for a VIDEO publish) — never a live-traffic condition;
      // still a typed, permanent, non-secret-leaking failure rather than
      // a raw crash.
      throw new PublishingProviderPermanentError("YOUTUBE_MEDIA_READER_MISSING", "No media reader was supplied for this VIDEO publish.");
    }
    const mediaReader = callbacks.mediaReader;
    const mediaAssetPublicId = input.artifact.mediaAssetPublicId;

    const prior = isYouTubeUploadCheckpoint(input.priorCheckpoint) ? input.priorCheckpoint : null;
    if (prior) {
      const resumed = await this.resumeFromCheckpoint(prior, mediaAssetPublicId, credential, callbacks, mediaReader);
      if (resumed) return resumed;
      // Falls through to start a brand-new session ONLY when the prior
      // session was conclusively determined to be gone (404 — see
      // resumeFromCheckpoint's own doc comment on why that is safe).
    }

    const head = await mediaReader.headObject(mediaAssetPublicId);
    const privacyStatus = input.metadata.privacy ?? "PRIVATE"; // Part L: default PRIVATE when the caller hasn't set one yet.

    const sessionUri = await this.createUploadSession(
      { title: input.metadata.title, description: input.metadata.description, tags: input.metadata.tags, privacyStatus },
      head,
      credential,
      callbacks,
    );
    // Checkpoint BEFORE uploading a single byte (Part U/V): if this
    // process crashes anywhere during the upload, a later attempt for
    // the SAME target finds this session URI via `priorCheckpoint` and
    // resumes/reconciles instead of blindly starting a second upload.
    await callbacks.saveCheckpoint({ uploadSessionUri: sessionUri, totalBytes: head.sizeBytes } satisfies YouTubeUploadCheckpoint);

    return this.uploadChunks(sessionUri, mediaAssetPublicId, head.sizeBytes, 0, credential, callbacks, mediaReader);
  }

  /**
   * Part U/V — before ever creating a NEW upload session, check whether
   * an EARLIER attempt (any generation) for this same target already
   * created one. Uses YouTube's own officially-documented resumable-
   * upload status-check (an empty PUT with a `Content-Range` header of
   * "bytes (wildcard)/TOTAL"): if the upload already completed — successfully or not —
   * "the API will return the same response that it sent when the upload
   * originally completed" (Google's own resumable-upload guide), so a
   * 200/201 here means the video already exists and this method returns
   * it directly, no new upload. A 308 means it is genuinely incomplete;
   * resumes from the byte offset the `Range` header reports. A 404 means
   * the session itself has expired — per the same guide, a session only
   * expires while genuinely incomplete/abandoned (a completed session
   * keeps answering with its completion response), so this is the one
   * case where starting a brand-new session is safe and does not risk a
   * duplicate.
   */
  private async resumeFromCheckpoint(
    checkpoint: YouTubeUploadCheckpoint,
    mediaAssetPublicId: string,
    credential: YouTubeCredentialPayload,
    callbacks: PublishingExecutionCallbacks,
    mediaReader: NonNullable<PublishingExecutionCallbacks["mediaReader"]>,
  ): Promise<PublishingPublishResult | null> {
    const { status, json, headers } = await this.requestAuthenticated("PUT", checkpoint.uploadSessionUri, credential, callbacks, undefined, { "Content-Range": `bytes */${checkpoint.totalBytes}` });
    if (status === 200 || status === 201) return this.parseVideoResource(json, "publish (resumed)");
    if (status === 404) return null; // safe to start fresh — see this method's own doc comment.
    if (status === 308) {
      const nextOffset = parseNextOffsetFromRange(headers.get("range"));
      return this.uploadChunks(checkpoint.uploadSessionUri, mediaAssetPublicId, checkpoint.totalBytes, nextOffset, credential, callbacks, mediaReader);
    }
    throw this.classifyFailure(status, json, "upload status check");
  }

  private async createUploadSession(
    metadata: { title: string; description?: string; tags?: string[]; privacyStatus: string },
    head: { sizeBytes: number; contentType?: string },
    credential: YouTubeCredentialPayload,
    callbacks: PublishingExecutionCallbacks,
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      snippet: {
        title: metadata.title,
        ...(metadata.description ? { description: metadata.description } : {}),
        ...(metadata.tags && metadata.tags.length > 0 ? { tags: metadata.tags } : {}),
        // No categoryId (Part K: never invent metadata Module 7 doesn't
        // produce) — YouTube applies its own default when omitted.
      },
      status: { privacyStatus: metadata.privacyStatus },
    };
    const { status, json, headers } = await this.requestAuthenticated(
      "POST",
      `${this.uploadBaseUrl}/videos?uploadType=resumable&part=snippet,status`,
      credential,
      callbacks,
      payload,
      { "X-Upload-Content-Length": String(head.sizeBytes), ...(head.contentType ? { "X-Upload-Content-Type": head.contentType } : {}) },
    );
    if (status !== 200 || !headers.get("location")) {
      throw this.classifyFailure(status, json, "upload session create");
    }
    return headers.get("location")!;
  }

  /**
   * Uploads bytes in bounded chunks (Part N — never the whole object in
   * one Buffer) starting at `startOffset` (0 for a brand-new session, or
   * a resumed offset). A chunk-level failure is NOT retried in-process
   * beyond `requestAuthenticated`'s own single reactive-401 retry — it
   * throws a RetryableError and lets Phase 9.3's existing worker retry
   * system re-invoke `publish()` later, which (thanks to the checkpoint
   * already saved before this method was ever called) resumes from the
   * correct offset via `resumeFromCheckpoint` rather than restarting the
   * upload — this IS "retry a chunk without rereading the full object,"
   * implemented via the outer retry mechanism instead of a second,
   * bespoke one (Part S: "Do not create a second retry framework").
   */
  private async uploadChunks(
    sessionUri: string,
    mediaAssetPublicId: string,
    totalBytes: number,
    startOffset: number,
    credential: YouTubeCredentialPayload,
    callbacks: PublishingExecutionCallbacks,
    mediaReader: NonNullable<PublishingExecutionCallbacks["mediaReader"]>,
  ): Promise<PublishingPublishResult> {
    let offset = startOffset;
    while (offset < totalBytes) {
      const end = Math.min(offset + this.chunkSizeBytes, totalBytes) - 1;
      const chunk = await mediaReader.readRange(mediaAssetPublicId, offset, end);
      const { status, json, headers } = await this.requestAuthenticated("PUT", sessionUri, credential, callbacks, chunk, { "Content-Range": `bytes ${offset}-${end}/${totalBytes}` });
      if (status === 200 || status === 201) {
        return this.parseVideoResource(json, "publish");
      }
      if (status === 308) {
        const reported = parseNextOffsetFromRange(headers.get("range"));
        offset = reported > 0 ? reported : end + 1;
        continue;
      }
      throw this.classifyFailure(status, json, "upload chunk");
    }
    // totalBytes === 0 (degenerate) — no chunk loop ever ran; treat as malformed rather than silently "succeeding" with nothing uploaded.
    throw new PublishingProviderPermanentError("YOUTUBE_MALFORMED_RESPONSE", "YouTube upload completed no chunk loop iterations (zero-byte artifact).");
  }

  private parseVideoResource(json: unknown, operation: string): PublishingPublishResult {
    if (isRecord(json) && typeof json.id === "string" && json.id.length > 0) {
      // A YouTube watch URL for an official, API-returned video id is
      // stable, universal, non-configurable Google API semantics (Part
      // W) — unlike WordPress, where the URL depends on a site's own
      // configurable permalink structure and must come from the API's
      // own returned `link`. This is applying one fixed, documented
      // template to an authoritative id, not fabricating a guess.
      return { externalContentId: json.id, externalUrl: `https://www.youtube.com/watch?v=${json.id}` };
    }
    throw this.classifyFailure(200, json, operation);
  }

  private classifyFailure(status: number, json: unknown, operation: string): PublishingProviderRetryableError | PublishingProviderPermanentError {
    const detail = `YouTube ${operation} failed (HTTP ${status}).`;
    if (status === 429) return new PublishingProviderRetryableError("YOUTUBE_RATE_LIMITED", detail);
    if (status >= 500) return new PublishingProviderRetryableError("YOUTUBE_SERVER_ERROR", detail);
    if (status === 401) return new PublishingProviderPermanentError("YOUTUBE_UNAUTHORIZED", detail);
    if (status === 403) {
      const reason = this.extractErrorReason(json);
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") {
        return new PublishingProviderRetryableError("YOUTUBE_QUOTA_EXCEEDED", detail);
      }
      if (reason === "insufficientPermissions" || reason === "forbidden") {
        return new PublishingProviderPermanentError("YOUTUBE_INSUFFICIENT_SCOPE", detail);
      }
      return new PublishingProviderPermanentError("YOUTUBE_FORBIDDEN", detail);
    }
    if (status === 400) return new PublishingProviderPermanentError("YOUTUBE_INVALID_PAYLOAD", detail);
    void json;
    return new PublishingProviderPermanentError("YOUTUBE_MALFORMED_RESPONSE", detail);
  }

  private classifyForbiddenAsConnectionResult(json: unknown): PublishingConnectionValidationResult {
    const reason = this.extractErrorReason(json);
    if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "userRateLimitExceeded" || reason === "rateLimitExceeded") {
      return { healthy: false, reasonCode: "PROVIDER_UNAVAILABLE", detail: "YouTube API quota/rate limit exceeded." };
    }
    if (reason === "insufficientPermissions" || reason === "forbidden") {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "The granted YouTube OAuth scope is insufficient." };
    }
    return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "YouTube rejected the credential (forbidden)." };
  }

  private extractErrorReason(json: unknown): string | undefined {
    if (!isRecord(json) || !isRecord(json.error)) return undefined;
    const errors = json.error.errors;
    if (Array.isArray(errors) && errors.length > 0 && isRecord(errors[0]) && typeof errors[0].reason === "string") return errors[0].reason;
    return undefined;
  }

  private async performRefresh(credential: YouTubeCredentialPayload, callbacks?: PublishingExecutionCallbacks): Promise<void> {
    const refreshed = await refreshYouTubeAccessToken(credential.refreshToken, this.oauth);
    if (callbacks?.onCredentialRefreshed) {
      const newCredential: YouTubeCredentialPayload = { ...credential, accessToken: refreshed.accessToken, scope: refreshed.scope ?? credential.scope };
      await callbacks.onCredentialRefreshed(newCredential as unknown as Record<string, unknown>, refreshed.expiresAt);
    }
    credential.accessToken = refreshed.accessToken; // update the in-memory copy every call site in THIS invocation shares.
  }

  /**
   * The one focused HTTP client this class uses for both the plain
   * YouTube Data API and the resumable-upload endpoint — reactive OAuth
   * refresh (a 401 triggers exactly one refresh-and-retry, never an
   * unbounded loop), bounded timeout, curated/sanitized errors. Never
   * logs or includes the access token in a thrown error's message.
   */
  private async requestAuthenticated(
    method: "GET" | "POST" | "PUT",
    url: string,
    credential: YouTubeCredentialPayload,
    callbacks: PublishingExecutionCallbacks | undefined,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const first = await this.request(method, url, credential.accessToken, body, extraHeaders);
    if (first.status !== 401) return first;
    await this.performRefresh(credential, callbacks);
    return this.request(method, url, credential.accessToken, body, extraHeaders);
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    url: string,
    accessToken: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<{ status: number; json: unknown; headers: Headers }> {
    const isBinaryBody = body instanceof Buffer || body instanceof Uint8Array;
    const isJsonBody = body !== undefined && !isBinaryBody;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(isJsonBody ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : isJsonBody ? JSON.stringify(body) : (body as Buffer | Uint8Array),
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error && err.name === "AbortError" ? "YouTube request timed out." : "YouTube request failed (network error).";
      throw new PublishingProviderRetryableError("YOUTUBE_NETWORK_ERROR", message);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let json: unknown;
    try {
      json = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: response.status, json, headers: response.headers };
  }
}
