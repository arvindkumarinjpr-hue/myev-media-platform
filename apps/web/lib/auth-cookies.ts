// Module 2 Phase 2.6 — the access token never reaches browser JS. It's set
// here as its own httpOnly cookie (on this app's own origin) by
// app/api/auth/login, read back only by server-side code (the backend
// proxy route, middleware), and forwarded as `Authorization: Bearer` when
// calling the real backend. The backend's own refresh_token cookie is
// relayed through unchanged — this app never reads or sets its value
// itself, only passes it along on refresh.
export const ACCESS_TOKEN_COOKIE = "myev_access_token";
export const REFRESH_TOKEN_COOKIE = "refresh_token";

// Matches ACCESS_TOKEN_TTL_SECONDS's backend default (900s / 15min) — see
// apps/api/src/config/configuration.ts. Kept as a constant here rather
// than plumbed through an extra request round-trip; if the backend's TTL
// ever changes, the proxy's refresh-on-401 path (not this cookie's own
// maxAge) is what actually keeps the session alive past it.
export const ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS = 900;
// Matches the backend's own refresh token TTL default (30 days) — see
// REFRESH_TOKEN_TTL_SECONDS in apps/api/src/config/configuration.ts.
export const REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * `strict` (not `lax`) matches the backend's own refresh_token cookie
 * exactly — every request on this app is same-origin (no legitimate
 * top-level-navigation-from-elsewhere use case), so there's no reason to
 * accept anything looser. Shared by the two places that set these
 * cookies (the login route and the backend proxy's refresh-on-401 path)
 * so the two can never silently drift apart.
 */
export function authCookieOptions(maxAgeSeconds: number): { httpOnly: true; secure: boolean; sameSite: "strict"; path: "/"; maxAge: number } {
  return { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict", path: "/", maxAge: maxAgeSeconds };
}
