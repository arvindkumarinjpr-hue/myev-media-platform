/**
 * The login page's `?next=` query param is attacker-controllable (anyone
 * can link to `/login?next=https://evil.example`) — only ever accept a
 * same-origin relative path. `//evil.example` is also rejected: browsers
 * treat a leading `//` as protocol-relative, i.e. still an external
 * origin, not a path.
 */
export function safeNextPath(next: string | null, fallback = "/workspaces"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return fallback;
  }
  return next;
}
