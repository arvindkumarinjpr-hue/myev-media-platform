import { NextResponse } from "next/server";
import { backendUrl } from "../../../../lib/config";
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS,
  authCookieOptions,
  REFRESH_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS,
} from "../../../../lib/auth-cookies";

/** Extracts just a named cookie's value out of a raw Set-Cookie header string — the backend's own cookie attributes (path, sameSite) are backend-specific and never reused verbatim here. */
function extractCookieValue(setCookieHeader: string, name: string): string | null {
  const match = setCookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.email !== "string" || typeof body.password !== "string") {
    return NextResponse.json({ code: "AUTH_VALIDATION_FAILED", message: "email and password are required." }, { status: 400 });
  }

  const backendRes = await fetch(`${backendUrl()}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email, password: body.password }),
  });
  const payload = await backendRes.json().catch(() => ({}));

  if (!backendRes.ok) {
    return NextResponse.json(payload, { status: backendRes.status });
  }

  const setCookieValues = backendRes.headers.getSetCookie?.() ?? [];
  const refreshCookieHeader = setCookieValues.find((value) => value.startsWith(`${REFRESH_TOKEN_COOKIE}=`));
  const refreshTokenValue = refreshCookieHeader ? extractCookieValue(refreshCookieHeader, REFRESH_TOKEN_COOKIE) : null;

  const response = NextResponse.json({ data: { user: payload.data.user } });
  response.cookies.set(ACCESS_TOKEN_COOKIE, payload.data.access_token as string, authCookieOptions(ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS));
  if (refreshTokenValue) {
    response.cookies.set(REFRESH_TOKEN_COOKIE, refreshTokenValue, authCookieOptions(REFRESH_TOKEN_COOKIE_MAX_AGE_SECONDS));
  }
  return response;
}
