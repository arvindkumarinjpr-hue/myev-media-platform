/**
 * Module 9 Phase 9.5 — Google OAuth 2.0 access-token refresh
 * (`refresh_token` grant) for the YouTube connector. Deliberately
 * separate from `wordpress-channel-provider.ts`'s own DNS-rebinding-safe
 * transport: Google's OAuth token endpoint is a FIXED, hardcoded,
 * non-user-configurable host (Part R — "YouTube endpoints are NOT
 * user-configured arbitrary hosts... this means WordPress's arbitrary-
 * target SSRF mechanism does not need to be copied wholesale"), so the
 * global `fetch` is used directly here — there is no attacker-
 * influenced hostname for a rebinding attack to target.
 *
 * Framework-free. Never logs a token. Never includes a token in a
 * thrown error's message.
 */

const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_TIMEOUT_MS = 15_000;

export interface YouTubeOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  /** Test-only override — never the production default. A real deployment always uses Google's own fixed token endpoint. */
  tokenEndpoint?: string;
  timeoutMs?: number;
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresAt: Date;
  /** The scope Google actually granted for the new access token, if returned — never assumed unchanged from what was originally requested. */
  scope?: string;
}

export class YouTubeOAuthRefreshError extends Error {
  constructor(
    public readonly reasonCode: "REFRESH_TOKEN_REVOKED" | "REFRESH_TRANSIENT_FAILURE" | "REFRESH_MALFORMED_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "YouTubeOAuthRefreshError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Exchanges a stored refresh token for a new access token. Throws
 * `YouTubeOAuthRefreshError` — `REFRESH_TOKEN_REVOKED` (Google's own
 * `invalid_grant` — the refresh token itself is dead; refreshing again
 * will never succeed without the user reconnecting) is the one
 * PERMANENT case; `REFRESH_TRANSIENT_FAILURE` (network/timeout/5xx/any
 * other 4xx) and `REFRESH_MALFORMED_RESPONSE` are both classified
 * RETRYABLE by the caller — a genuinely unexpected shape is worth
 * retrying rather than assuming the worst.
 */
export async function refreshYouTubeAccessToken(refreshToken: string, options: YouTubeOAuthClientOptions): Promise<RefreshedAccessToken> {
  const endpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch {
    // Never include the caught error's own message verbatim — a network
    // library's error can, in principle, echo request details.
    throw new YouTubeOAuthRefreshError("REFRESH_TRANSIENT_FAILURE", "YouTube OAuth token refresh failed (network error or timeout).");
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new YouTubeOAuthRefreshError("REFRESH_MALFORMED_RESPONSE", "YouTube OAuth token refresh returned a non-JSON response.");
  }

  if (!response.ok) {
    const errorCode = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
    if (errorCode === "invalid_grant") {
      throw new YouTubeOAuthRefreshError("REFRESH_TOKEN_REVOKED", "The stored YouTube refresh token is no longer valid (revoked, expired, or the account disconnected access).");
    }
    throw new YouTubeOAuthRefreshError("REFRESH_TRANSIENT_FAILURE", `YouTube OAuth token refresh failed (HTTP ${response.status}).`);
  }

  if (!isRecord(json) || typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
    throw new YouTubeOAuthRefreshError("REFRESH_MALFORMED_RESPONSE", "YouTube OAuth token refresh response was missing access_token/expires_in.");
  }

  return {
    accessToken: json.access_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}
