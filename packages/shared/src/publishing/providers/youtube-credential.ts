/**
 * Module 9 Phase 9.5 — the structured shape of a YouTube
 * ChannelCredential's decrypted payload. Mirrors `ChannelCredential`'s
 * own schema comment ("{accessToken, refreshToken, scope} for OAuth")
 * and the frozen FRD's own logical schema (oauth_token_encrypted /
 * oauth_refresh_token_encrypted / scope_granted).
 */
export interface YouTubeCredentialPayload {
  accessToken: string;
  refreshToken: string;
  /** Space-delimited OAuth scope string, as returned by Google's token endpoint — never invented, always exactly what Google granted. */
  scope?: string;
  /** The connected channel's own YouTube channel id, if known — used only for display/identity purposes, never trusted as an authorization boundary. */
  externalChannelId?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Narrows an opaque decrypted credential `Record<string, unknown>` into a
 * `YouTubeCredentialPayload`, or `null` if the shape is missing/malformed
 * — never throws. Mirrors `parseWordPressCredential()`'s own manual-
 * narrowing style exactly (no class-validator — matches this file's own
 * plain-interface convention for credential payloads).
 */
export function parseYouTubeCredential(raw: Record<string, unknown>): YouTubeCredentialPayload | null {
  const { accessToken, refreshToken, scope, externalChannelId } = raw;
  if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) return null;
  return {
    accessToken,
    refreshToken,
    scope: isNonEmptyString(scope) ? scope : undefined,
    externalChannelId: isNonEmptyString(externalChannelId) ? externalChannelId : undefined,
  };
}
