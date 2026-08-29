import { NextResponse } from "next/server";
import { backendUrl } from "../../../../lib/config";

/**
 * Unauthenticated pass-through — no cookies to read or set. The backend
 * itself is what makes this enumeration-safe (an identical 200 + generic
 * message whether or not the account exists); this route just relays
 * whatever the backend decides, never inspecting or branching on it.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body.email !== "string") {
    return NextResponse.json({ code: "AUTH_VALIDATION_FAILED", message: "email is required." }, { status: 400 });
  }

  const backendRes = await fetch(`${backendUrl()}/api/v1/auth/forgot-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: body.email }),
  });
  const payload = await backendRes.json().catch(() => ({}));

  return NextResponse.json(payload, { status: backendRes.status });
}
