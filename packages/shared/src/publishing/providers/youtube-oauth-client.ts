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
const DEFAULT_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TIMEOUT_MS = 15_000;

// Module 9 Phase 9.6's own least-privilege research finding, reused
// verbatim here (Phase 9.7 does not re-derive scope requirements) — the
// one scope YouTubeChannelProvider's resumable upload needs.
export const YOUTUBE_OAUTH_SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

export interface YouTubeOAuthClientOptions {
  clientId: string;
  clientSecret: string;
  /** Test-only override — never the production default. A real deployment always uses Google's own fixed token endpoint. */
  tokenEndpoint?: string;
  /** Test-only override for the authorization (browser-redirect) endpoint. */
  authorizationEndpoint?: string;
  timeoutMs?: number;
}

export interface ExchangedAccessToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  scope?: string;
}

/**
 * Module 9 Phase 9.7 — builds the URL the browser is redirected to for
 * the Google consent screen. `access_type=offline` + `prompt=consent`
 * are both required to reliably receive a `refresh_token` on every
 * connect (Google only returns one on the FIRST consent, or when
 * `prompt=consent` forces it again) — YouTubeChannelProvider has no
 * access-token-only mode, so a connect that silently omits the refresh
 * token would be unusable. `state` is opaque here — the caller (this
 * process's own OAuth state service) is solely responsible for its
 * content/security properties; this function never inspects it.
 */
export function buildYouTubeAuthorizationUrl(options: YouTubeOAuthClientOptions, params: { redirectUri: string; state: string; scopes?: string[] }): string {
  const endpoint = options.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT;
  const query = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: (params.scopes ?? YOUTUBE_OAUTH_SCOPES).join(" "),
    access_type: "offline",
    prompt: "consent",
    state: params.state,
  });
  return `${endpoint}?${query.toString()}`;
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

export class YouTubeOAuthExchangeError extends Error {
  constructor(
    public readonly reasonCode: "EXCHANGE_INVALID_GRANT" | "EXCHANGE_TRANSIENT_FAILURE" | "EXCHANGE_MALFORMED_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "YouTubeOAuthExchangeError";
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

/**
 * Module 9 Phase 9.7 — the authorization_code grant, exchanging the
 * one-time code Google's redirect delivered to the callback endpoint for
 * a real access+refresh token pair. `redirectUri` MUST be byte-identical
 * to the one used in `buildYouTubeAuthorizationUrl()` for this same
 * flow — Google rejects a mismatch. Throws `EXCHANGE_INVALID_GRANT`
 * (the code is already used/expired/malformed — permanent, the caller
 * must restart the connect flow) vs `EXCHANGE_TRANSIENT_FAILURE`
 * (network/5xx — safe to show a generic "try again") vs
 * `EXCHANGE_MALFORMED_RESPONSE`. Never includes the code or a token in
 * a thrown message.
 */
export async function exchangeYouTubeAuthorizationCode(code: string, redirectUri: string, options: YouTubeOAuthClientOptions): Promise<ExchangedAccessToken> {
  const endpoint = options.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const body = new URLSearchParams({
    client_id: options.clientId,
    client_secret: options.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
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
    throw new YouTubeOAuthExchangeError("EXCHANGE_TRANSIENT_FAILURE", "YouTube OAuth code exchange failed (network error or timeout).");
  } finally {
    clearTimeout(timer);
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new YouTubeOAuthExchangeError("EXCHANGE_MALFORMED_RESPONSE", "YouTube OAuth code exchange returned a non-JSON response.");
  }

  if (!response.ok) {
    const errorCode = isRecord(json) && typeof json.error === "string" ? json.error : undefined;
    if (errorCode === "invalid_grant") {
      throw new YouTubeOAuthExchangeError("EXCHANGE_INVALID_GRANT", "The authorization code is invalid, expired, or already used.");
    }
    throw new YouTubeOAuthExchangeError("EXCHANGE_TRANSIENT_FAILURE", `YouTube OAuth code exchange failed (HTTP ${response.status}).`);
  }

  if (!isRecord(json) || typeof json.access_token !== "string" || typeof json.refresh_token !== "string" || typeof json.expires_in !== "number") {
    // A missing refresh_token specifically means the user was not shown
    // (or did not need) a consent prompt — buildYouTubeAuthorizationUrl's
    // own access_type=offline + prompt=consent should always prevent
    // this, but the check stays here as a defensive, honest failure
    // rather than silently persisting a channel that can never refresh.
    throw new YouTubeOAuthExchangeError("EXCHANGE_MALFORMED_RESPONSE", "YouTube OAuth code exchange response was missing access_token/refresh_token/expires_in.");
  }

  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: new Date(Date.now() + json.expires_in * 1000),
    scope: typeof json.scope === "string" ? json.scope : undefined,
  };
}

export interface YouTubeChannelIdentity {
  channelId: string;
  title: string;
}

export class YouTubeIdentityLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YouTubeIdentityLookupError";
  }
}

/**
 * Module 9 Phase 9.7 — a real, authoritative channel id + title
 * immediately after a fresh OAuth connect, so `PublishingChannelAccount.
 * displayName`/`externalAccountId` are the actual connected channel's own
 * identity — never a placeholder or a value invented client-side (Part
 * G's own "discover manageable Pages"/account-identity principle, applied
 * to YouTube). Read-only; never used by the publish path itself (that
 * stays exactly YouTubeChannelProvider's own concern).
 */
export async function fetchYouTubeChannelIdentity(accessToken: string, options: { apiBaseUrl?: string; timeoutMs?: number } = {}): Promise<YouTubeChannelIdentity> {
  const baseUrl = options.apiBaseUrl ?? "https://www.googleapis.com/youtube/v3";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: controller.signal });
  } catch {
    throw new YouTubeIdentityLookupError("Failed to look up the connected YouTube channel's identity (network error or timeout).");
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new YouTubeIdentityLookupError(`Failed to look up the connected YouTube channel's identity (HTTP ${response.status}).`);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new YouTubeIdentityLookupError("YouTube channel identity lookup returned a non-JSON response.");
  }
  const items = isRecord(json) && Array.isArray(json.items) ? json.items : undefined;
  const first = items?.[0];
  const channelId = isRecord(first) && typeof first.id === "string" ? first.id : undefined;
  const title = isRecord(first) && isRecord(first.snippet) && typeof first.snippet.title === "string" ? first.snippet.title : undefined;
  if (!channelId || !title) {
    throw new YouTubeIdentityLookupError("YouTube channel identity lookup returned no channel for this account.");
  }
  return { channelId, title };
}
