import { NextResponse, type NextRequest } from "next/server";
import { ACCESS_TOKEN_COOKIE } from "./lib/auth-cookies";

// UX gating only — presence of the cookie, not its validity, which the
// backend alone is authoritative on for every real mutation/read (§9 of
// the Phase 2.6 brief). An expired-but-present cookie still reaches a
// page; that page's own data fetch then 401s and the page-level error
// state sends the user back to /login.
export function middleware(request: NextRequest): NextResponse {
  const isAuthenticated = Boolean(request.cookies.get(ACCESS_TOKEN_COOKIE)?.value);
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/workspaces") && !isAuthenticated) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }
  if (pathname === "/login" && isAuthenticated) {
    return NextResponse.redirect(new URL("/workspaces", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/workspaces/:path*", "/login"],
};
