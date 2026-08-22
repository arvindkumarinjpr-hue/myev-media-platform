import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { backendUrl } from "../../../../lib/config";
import { ACCESS_TOKEN_COOKIE, REFRESH_TOKEN_COOKIE } from "../../../../lib/auth-cookies";

export async function POST(): Promise<Response> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;

  if (accessToken) {
    // Best-effort — the session is being torn down client-side either way.
    await fetch(`${backendUrl()}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch(() => undefined);
  }

  const response = NextResponse.json({ data: { success: true } });
  response.cookies.delete(ACCESS_TOKEN_COOKIE);
  response.cookies.delete(REFRESH_TOKEN_COOKIE);
  return response;
}
