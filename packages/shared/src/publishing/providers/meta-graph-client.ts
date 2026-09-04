import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";

/**
 * Module 9 Phase 9.6 — the ONE Graph API version FacebookChannelProvider
 * and InstagramChannelProvider both call. A frozen code constant, never
 * user/workspace-configurable (Part V: "Avoid user-controlled API-version
 * selection"). Bump this deliberately, in one place, when Meta deprecates
 * the current version — never mix versions across call sites.
 */
export const META_GRAPH_API_VERSION = "v25.0";

const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_UPLOAD_BASE_URL = "https://rupload.facebook.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface MetaGraphClientOptions {
  /** Test-only override — production always uses the fixed official host (Part U: "Do not permit workspace credential to override production API base URL"). */
  graphBaseUrl?: string;
  /** Test-only override for the rupload.facebook.com resumable-media-upload host. */
  uploadBaseUrl?: string;
  timeoutMs?: number;
}

interface MetaGraphErrorShape {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    is_transient?: boolean;
    fbtrace_id?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function encodeFormBody(body: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) continue;
    params.set(key, typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value));
  }
  return params.toString();
}

function parseMetaGraphError(json: unknown): MetaGraphErrorShape["error"] | undefined {
  if (!isRecord(json) || !isRecord(json.error)) return undefined;
  const err = json.error;
  return {
    message: typeof err.message === "string" ? err.message : undefined,
    type: typeof err.type === "string" ? err.type : undefined,
    code: typeof err.code === "number" ? err.code : undefined,
    error_subcode: typeof err.error_subcode === "number" ? err.error_subcode : undefined,
    is_transient: typeof err.is_transient === "boolean" ? err.is_transient : undefined,
    fbtrace_id: typeof err.fbtrace_id === "string" ? err.fbtrace_id : undefined,
  };
}

// Rate-limit-family error codes per Meta's own documented Graph API error
// taxonomy (Part X: "Do not invent numeric rate limits" — these codes are
// Meta's own, not a guessed threshold/count). 4 = API Too Many Calls, 17 =
// User Too Many Calls, 32 = Page Too Many Calls, 613 = Custom rate limit,
// 80001-family = business-use-case rate limiting.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80004]);
// 190 = OAuthException (invalid/expired/revoked access token) — permanent
// for Phase 9.6 since no refresh mechanism exists yet (Part F finding).
const INVALID_TOKEN_CODE = 190;
// 10 / 200-299 = permission errors (missing scope).
const PERMISSION_ERROR_CODES = new Set([10, 200, 210, 294, 298]);

/**
 * Module 9 Phase 9.6 — the shared, provider-neutral Graph API error
 * classifier (Part W). Reads Meta's own structured `{error: {code,
 * error_subcode, is_transient, ...}}` shape — never a raw HTTP status
 * alone, since Meta's own guidance is that `is_transient`/`code` are more
 * reliable than the HTTP status. NEVER persists/returns the raw Graph
 * error body — only a stable MYEV error code + a fixed, curated message
 * per classification, exactly mirroring `YouTubeChannelProvider.classifyFailure()`'s
 * own discipline (never echo the provider's raw response text into a
 * thrown/persisted message).
 */
export function classifyMetaGraphFailure(status: number, json: unknown, operation: string): PublishingProviderRetryableError | PublishingProviderPermanentError {
  const detail = `Meta Graph API ${operation} failed (HTTP ${status}).`;
  const error = parseMetaGraphError(json);

  if (error?.is_transient === true) return new PublishingProviderRetryableError("META_TRANSIENT_ERROR", detail);
  if (error?.code !== undefined && RATE_LIMIT_CODES.has(error.code)) return new PublishingProviderRetryableError("META_RATE_LIMITED", detail);
  if (error?.code === INVALID_TOKEN_CODE) return new PublishingProviderPermanentError("META_UNAUTHORIZED", detail);
  if (error?.code !== undefined && PERMISSION_ERROR_CODES.has(error.code)) return new PublishingProviderPermanentError("META_INSUFFICIENT_PERMISSION", detail);
  if (status === 429) return new PublishingProviderRetryableError("META_RATE_LIMITED", detail);
  if (status >= 500) return new PublishingProviderRetryableError("META_SERVER_ERROR", detail);
  if (status === 401) return new PublishingProviderPermanentError("META_UNAUTHORIZED", detail);
  if (status === 400) return new PublishingProviderPermanentError("META_INVALID_PAYLOAD", detail);
  return new PublishingProviderPermanentError("META_MALFORMED_RESPONSE", detail);
}

/**
 * Module 9 Phase 9.6 — the ONE focused HTTP client FacebookChannelProvider
 * and InstagramChannelProvider both use (Part U/D: "shared: auth parsing,
 * Graph API transport" — never scattered `fetch()` calls in either
 * provider). Fixed official hosts unless a test explicitly overrides them.
 * No reactive-refresh-and-retry chokepoint like YouTube's — Part F's
 * research finding is that a Page access token derived from a long-lived
 * user token does not expire on its own (it only dies if the user's own
 * role/session is revoked), so there is no refresh flow to perform here;
 * a 401/190 is always classified permanent.
 */
export class MetaGraphClient {
  private readonly graphBaseUrl: string;
  private readonly uploadBaseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: MetaGraphClientOptions = {}) {
    this.graphBaseUrl = options.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL;
    this.uploadBaseUrl = options.uploadBaseUrl ?? DEFAULT_UPLOAD_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * A Graph API call against the versioned `graph.facebook.com` host —
   * `path` starts with "/" and never includes the version prefix (added
   * here, once). Meta's Graph API expects POST parameters as
   * `application/x-www-form-urlencoded`, not a raw JSON body (confirmed
   * against Meta's own documented examples — never assumed). The access
   * token travels ONLY in the `Authorization` header (Part U/AE) — never
   * duplicated into the form body, minimizing where it can ever appear in
   * a captured request.
   */
  async graphRequest(method: "GET" | "POST", path: string, accessToken: string, body?: Record<string, unknown>): Promise<{ status: number; json: unknown }> {
    const url = `${this.graphBaseUrl}/${META_GRAPH_API_VERSION}${path}`;
    return this.request(method, url, accessToken, body ? encodeFormBody(body) : undefined, body ? { "Content-Type": "application/x-www-form-urlencoded" } : undefined);
  }

  /** A resumable-media-upload call against the `rupload.facebook.com` host — `path` is the full upload path (e.g. `/ig-api-upload/<CONTAINER_ID>`), never versioned. */
  async uploadRequest(path: string, accessToken: string, body: Buffer, extraHeaders: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const url = `${this.uploadBaseUrl}${path}`;
    return this.request("POST", url, accessToken, body, extraHeaders);
  }

  private async request(method: "GET" | "POST", url: string, accessToken: string, body: string | Buffer | undefined, extraHeaders?: Record<string, string>): Promise<{ status: number; json: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      // Token in the Authorization header where the official API supports
      // it (Part U) — the rupload host requires it; the graph host also
      // accepts it, so it is used uniformly here rather than only via the
      // `access_token` body/query param.
      response = await fetch(url, {
        method,
        headers: { Authorization: `OAuth ${accessToken}`, ...extraHeaders },
        body,
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error && err.name === "AbortError" ? "Meta Graph API request timed out." : "Meta Graph API request failed (network error).";
      throw new PublishingProviderRetryableError("META_NETWORK_ERROR", message);
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
    return { status: response.status, json };
  }
}
