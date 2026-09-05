import { META_GRAPH_API_VERSION } from "./meta-graph-client";

/**
 * Module 9 Phase 9.7 — the Meta (Facebook Login) OAuth connect flow this
 * process's own OAuth controller drives: authorization URL, code
 * exchange (short-lived user token), long-lived token exchange, and
 * account discovery (manageable Pages + their linked Instagram Business
 * accounts). Distinct from `meta-graph-client.ts` (the PUBLISHING-time
 * transport FacebookChannelProvider/InstagramChannelProvider use) —
 * this file is the CONNECT-time flow, never imported by either
 * connector. Reuses the identical frozen Graph API version constant so
 * the two never drift.
 *
 * Fixed official Meta hosts unless a test explicitly overrides them —
 * same discipline as `MetaGraphClient` (Part U: never a workspace/
 * user-supplied API base URL in production).
 */
const DEFAULT_DIALOG_BASE_URL = "https://www.facebook.com";
const DEFAULT_GRAPH_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT_MS = 15_000;

// Module 9 Phase 9.6's own least-privilege research findings, reused
// verbatim (Phase 9.7 does not re-derive permission requirements). One
// combined connect flow requests the union of what Facebook and
// Instagram publishing each need — the account-selection step afterward
// (Part H) is what actually decides which Page/IG account gets
// registered for which channel; requesting the union once avoids forcing
// the operator through two separate Meta consent dialogs for what is,
// from the user's perspective, one "connect my Meta account" action.
export const META_OAUTH_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish"];

export interface MetaOAuthClientOptions {
  appId: string;
  appSecret: string;
  /** Test-only override. */
  dialogBaseUrl?: string;
  /** Test-only override. */
  graphBaseUrl?: string;
  timeoutMs?: number;
}

export class MetaOAuthError extends Error {
  constructor(
    public readonly reasonCode: "EXCHANGE_INVALID_GRANT" | "EXCHANGE_TRANSIENT_FAILURE" | "EXCHANGE_MALFORMED_RESPONSE" | "DISCOVERY_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "MetaOAuthError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Builds the URL the browser is redirected to for the Meta consent dialog. `state` is opaque — the caller's own OAuth state service owns its security properties. */
export function buildMetaAuthorizationUrl(options: MetaOAuthClientOptions, params: { redirectUri: string; state: string; scopes?: string[] }): string {
  const base = options.dialogBaseUrl ?? DEFAULT_DIALOG_BASE_URL;
  const query = new URLSearchParams({
    client_id: options.appId,
    redirect_uri: params.redirectUri,
    response_type: "code",
    scope: (params.scopes ?? META_OAUTH_SCOPES).join(","),
    state: params.state,
  });
  return `${base}/${META_GRAPH_API_VERSION}/dialog/oauth?${query.toString()}`;
}

async function graphGet(
  path: string,
  options: MetaOAuthClientOptions,
  accessToken?: string,
  onFailureReasonCode: "EXCHANGE_TRANSIENT_FAILURE" | "DISCOVERY_FAILED" = "EXCHANGE_TRANSIENT_FAILURE",
): Promise<{ status: number; json: unknown }> {
  const base = options.graphBaseUrl ?? DEFAULT_GRAPH_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${base}/${META_GRAPH_API_VERSION}${path}`, { headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined, signal: controller.signal });
  } catch {
    throw new MetaOAuthError(onFailureReasonCode, "Meta OAuth request failed (network error or timeout).");
  } finally {
    clearTimeout(timer);
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new MetaOAuthError(onFailureReasonCode === "DISCOVERY_FAILED" ? "DISCOVERY_FAILED" : "EXCHANGE_MALFORMED_RESPONSE", "Meta OAuth request returned a non-JSON response.");
  }
  return { status: response.status, json };
}

function classifyTokenExchangeFailure(status: number, json: unknown): never {
  const errorType = isRecord(json) && isRecord(json.error) && typeof json.error.type === "string" ? json.error.type : undefined;
  if (status === 400 || errorType === "OAuthException") {
    throw new MetaOAuthError("EXCHANGE_INVALID_GRANT", "The authorization code or token is invalid, expired, or already used.");
  }
  throw new MetaOAuthError("EXCHANGE_TRANSIENT_FAILURE", `Meta OAuth token exchange failed (HTTP ${status}).`);
}

export interface MetaExchangedToken {
  accessToken: string;
  expiresAt: Date | null;
}

/** Exchanges the one-time authorization code for a SHORT-lived user access token. `redirectUri` must be byte-identical to the one used to build the authorization URL for this flow. */
export async function exchangeMetaAuthorizationCode(code: string, redirectUri: string, options: MetaOAuthClientOptions): Promise<MetaExchangedToken> {
  const query = new URLSearchParams({ client_id: options.appId, redirect_uri: redirectUri, client_secret: options.appSecret, code });
  const { status, json } = await graphGet(`/oauth/access_token?${query.toString()}`, options);
  if (status < 200 || status >= 300 || !isRecord(json) || typeof json.access_token !== "string") {
    classifyTokenExchangeFailure(status, json);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return { accessToken: json.access_token, expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null };
}

/**
 * Exchanges a short-lived user token for a LONG-lived one (~60 days,
 * per Meta's own documented, non-configurable lifetime — never
 * hardcoded/assumed here, `expiresAt` always comes from Meta's own
 * `expires_in`). This long-lived USER token is what a Page access token
 * is later derived from (via `fetchManageablePages`) — a Page token
 * derived from a long-lived user token does not itself expire (Phase
 * 9.6's own research finding), so this is the ONE exchange this connect
 * flow performs; there is no separate "refresh the Page token" step.
 */
export async function exchangeForLongLivedMetaToken(shortLivedToken: string, options: MetaOAuthClientOptions): Promise<MetaExchangedToken> {
  const query = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: options.appId, client_secret: options.appSecret, fb_exchange_token: shortLivedToken });
  const { status, json } = await graphGet(`/oauth/access_token?${query.toString()}`, options);
  if (status < 200 || status >= 300 || !isRecord(json) || typeof json.access_token !== "string") {
    classifyTokenExchangeFailure(status, json);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return { accessToken: json.access_token, expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null };
}

export interface MetaManageablePage {
  pageId: string;
  name: string;
  /** The Page's own access token — already returned by /me/accounts, no separate derivation call needed. Non-expiring as long as the underlying long-lived user token/role remains valid (Phase 9.6 research finding). */
  pageAccessToken: string;
  /** Present only when this Page has a linked Instagram professional account. */
  instagramBusinessAccountId?: string;
}

/**
 * Discovers every Page the connected user can administer, WITH each
 * Page's own derived access token and its linked Instagram Business
 * Account id where one exists (Part G/H — "discover manageable Pages"
 * for Facebook, "discover eligible linked professional accounts... via
 * the actual selected Meta auth model" for Instagram: this codebase
 * uses the Facebook-Login-linked-Page model, so Instagram accounts are
 * discovered exclusively through their linked Page here, never
 * independently). The account-selection step (this process's own OAuth
 * callback service) is what decides which of these become a real
 * `PublishingChannelAccount` row — this function only reads.
 */
export async function fetchManageablePages(userAccessToken: string, options: MetaOAuthClientOptions): Promise<MetaManageablePage[]> {
  const { status, json } = await graphGet("/me/accounts?fields=id,name,access_token,instagram_business_account", options, userAccessToken, "DISCOVERY_FAILED");
  if (status < 200 || status >= 300 || !isRecord(json) || !Array.isArray(json.data)) {
    throw new MetaOAuthError("DISCOVERY_FAILED", `Failed to list manageable Facebook Pages (HTTP ${status}).`);
  }
  const pages: MetaManageablePage[] = [];
  for (const entry of json.data) {
    if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.name !== "string" || typeof entry.access_token !== "string") continue;
    const igAccount = isRecord(entry.instagram_business_account) && typeof entry.instagram_business_account.id === "string" ? entry.instagram_business_account.id : undefined;
    pages.push({ pageId: entry.id, name: entry.name, pageAccessToken: entry.access_token, instagramBusinessAccountId: igAccount });
  }
  return pages;
}

export interface InstagramAccountIdentity {
  igUserId: string;
  username?: string;
  /** BUSINESS or MEDIA_CREATOR are the only publishable account types (Part H: "Do not assume personal Instagram accounts are publishable") — a caller filters on this before offering the account as selectable. */
  accountType?: string;
}

/** Reads a linked Instagram account's own identity/type — the SAME check InstagramChannelProvider.validateConnection() performs at publish-readiness time, reused here at connect-time so an unpublishable (personal) account is never even offered for selection. */
export async function fetchInstagramAccountIdentity(igUserId: string, pageAccessToken: string, options: MetaOAuthClientOptions): Promise<InstagramAccountIdentity> {
  const { status, json } = await graphGet(`/${igUserId}?fields=id,username,account_type`, options, pageAccessToken, "DISCOVERY_FAILED");
  if (status < 200 || status >= 300 || !isRecord(json) || typeof json.id !== "string") {
    throw new MetaOAuthError("DISCOVERY_FAILED", `Failed to look up the Instagram account's identity (HTTP ${status}).`);
  }
  return {
    igUserId: json.id,
    username: typeof json.username === "string" ? json.username : undefined,
    accountType: typeof json.account_type === "string" ? json.account_type : undefined,
  };
}
