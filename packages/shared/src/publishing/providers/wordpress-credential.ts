/**
 * Module 9 Phase 9.4 — the WordPress `ChannelCredential` secret payload
 * shape, matching the schema's own doc comment exactly
 * (`{applicationPassword}` for WordPress, alongside `siteUrl`/`username`
 * — WordPress core's own native Application Passwords REST-API auth
 * mechanism, not OAuth; WordPress.org self-hosted sites have no
 * standard OAuth flow). A plain interface, manually narrowed at the
 * point of use — matching this codebase's own established convention
 * for in-process, never-framework-validated data (the same style
 * `readPublishingMetadataBag` already uses), not a class-validator DTO
 * (no HTTP "connect channel" endpoint exists yet to validate a request
 * body against).
 */
export interface WordPressCredentialPayload {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

export function parseWordPressCredential(raw: Record<string, unknown>): WordPressCredentialPayload | null {
  const { siteUrl, username, applicationPassword } = raw;
  if (typeof siteUrl !== "string" || siteUrl.length === 0) return null;
  if (typeof username !== "string" || username.length === 0) return null;
  if (typeof applicationPassword !== "string" || applicationPassword.length === 0) return null;
  return { siteUrl, username, applicationPassword };
}
