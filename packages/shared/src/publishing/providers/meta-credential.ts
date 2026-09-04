/**
 * Module 9 Phase 9.6 — the structured shape of a Meta (Facebook/Instagram)
 * ChannelCredential's decrypted payload. Deliberately shared across both
 * providers (Part D: "shared: auth parsing") since both are ultimately
 * backed by the SAME Page-derived access token — a Facebook connection
 * only ever needs `pageId`; an Instagram connection only ever needs
 * `igUserId` (the linked professional account's own id); a workspace that
 * connects both channels off the same Page may populate both.
 *
 * No `refreshToken` field (Part E/F): research into Meta's actual current
 * token model found no Google-style refresh-token grant. A Page access
 * token derived from a long-lived User access token does not expire on
 * its own — it only stops working if the authorizing user's own session/
 * role is revoked, at which point re-authorization (a human
 * reconnecting the account in a future Phase 9.7 OAuth-connect UI) is the
 * only path, not an automated refresh. `tokenExpiresAt` is therefore
 * genuinely optional/typically absent here, unlike YouTube's OAuth token.
 */
export interface MetaCredentialPayload {
  accessToken: string;
  /** Facebook Page id — required for FacebookChannelProvider, optional for Instagram (a workspace may have connected only Instagram off a Page it doesn't otherwise publish to). */
  pageId?: string;
  /** The linked Instagram professional (Business/Creator) account id — required for InstagramChannelProvider. */
  igUserId?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Narrows an opaque decrypted credential `Record<string, unknown>` into a
 * `MetaCredentialPayload`, or `null` if `accessToken` itself is missing/
 * malformed — never throws. Mirrors `parseYouTubeCredential()`'s own
 * manual-narrowing style. `pageId`/`igUserId` presence is NOT validated
 * here (this parser is shared by both channels, each of which requires a
 * different one) — each provider validates its own required field after
 * parsing.
 */
export function parseMetaCredential(raw: Record<string, unknown>): MetaCredentialPayload | null {
  const { accessToken, pageId, igUserId } = raw;
  if (!isNonEmptyString(accessToken)) return null;
  return {
    accessToken,
    pageId: isNonEmptyString(pageId) ? pageId : undefined,
    igUserId: isNonEmptyString(igUserId) ? igUserId : undefined,
  };
}
