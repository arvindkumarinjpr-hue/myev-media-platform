import { NextResponse } from "next/server";
import { backendUrl } from "../../../../lib/config";

/**
 * Unauthenticated pass-through, shared by both /reset-password and
 * /activate on the frontend — the backend itself treats password reset
 * and account activation as the same operation (AuthService.resetPassword),
 * distinguished only by the token's own stored purpose. No cookies to
 * read or set: a successful reset/activation never returns a session:
 * the caller is never auto-logged-in.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.token !== "string" || typeof body.newPassword !== "string") {
    return NextResponse.json({ code: "AUTH_VALIDATION_FAILED", message: "token and newPassword are required." }, { status: 400 });
  }

  const backendRes = await fetch(`${backendUrl()}/api/v1/auth/reset-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: body.token, newPassword: body.newPassword }),
  });
  const payload = await backendRes.json().catch(() => ({}));

  return NextResponse.json(payload, { status: backendRes.status });
}
