import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { backendUrl } from "../../../../lib/config";
import { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS, REFRESH_TOKEN_COOKIE } from "../../../../lib/auth-cookies";

/**
 * The one place the browser's own requests ever leave this app's origin.
 * Every Knowledge Pack / Project / Workspace call from a Client Component
 * goes through here: attaches the httpOnly access token as
 * `Authorization: Bearer`, forwards the `workspaces/:workspaceId/...`
 * segment as `X-Workspace-Id` too (WorkspaceContextGuard expects both),
 * and — since the access token is a short-lived 15-minute bearer token —
 * retries exactly once via the refresh_token cookie on a 401 before
 * giving up and reporting it to the client.
 */
async function handle(request: NextRequest, path: string[]): Promise<Response> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    return NextResponse.json({ code: "AUTH_TOKEN_INVALID", message: "Not signed in." }, { status: 401 });
  }

  const targetPath = path.join("/");
  const search = request.nextUrl.search;
  const workspaceId = path[0] === "workspaces" ? path[1] : undefined;
  const method = request.method;
  const body = method === "GET" || method === "DELETE" ? undefined : await request.text();

  const doFetch = (token: string) =>
    fetch(`${backendUrl()}/api/v1/${targetPath}${search}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body,
    });

  let backendRes = await doFetch(accessToken);

  if (backendRes.status === 401) {
    const refreshed = await tryRefresh(cookieStore.get(REFRESH_TOKEN_COOKIE)?.value);
    if (refreshed) {
      backendRes = await doFetch(refreshed.accessToken);
      const payload = await backendRes.text();
      const response = new NextResponse(payload, { status: backendRes.status, headers: { "Content-Type": "application/json" } });
      response.cookies.set(ACCESS_TOKEN_COOKIE, refreshed.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_SECONDS,
      });
      if (refreshed.refreshTokenValue) {
        response.cookies.set(REFRESH_TOKEN_COOKIE, refreshed.refreshTokenValue, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: 60 * 60 * 24 * 30,
        });
      }
      return response;
    }
  }

  const payload = await backendRes.text();
  return new NextResponse(payload, { status: backendRes.status, headers: { "Content-Type": "application/json" } });
}

async function tryRefresh(refreshTokenValue: string | undefined): Promise<{ accessToken: string; refreshTokenValue: string | null } | null> {
  if (!refreshTokenValue) return null;
  const res = await fetch(`${backendUrl()}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { Cookie: `${REFRESH_TOKEN_COOKIE}=${refreshTokenValue}` },
  });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => null);
  if (!payload?.data?.access_token) return null;

  const setCookieValues = res.headers.getSetCookie?.() ?? [];
  const nextRefreshCookie = setCookieValues.find((value) => value.startsWith(`${REFRESH_TOKEN_COOKIE}=`));
  const match = nextRefreshCookie?.match(new RegExp(`${REFRESH_TOKEN_COOKIE}=([^;]+)`));
  return { accessToken: payload.data.access_token as string, refreshTokenValue: match ? match[1] : null };
}

type RouteParams = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: RouteParams): Promise<Response> {
  return handle(request, (await params).path);
}
export async function POST(request: NextRequest, { params }: RouteParams): Promise<Response> {
  return handle(request, (await params).path);
}
export async function PATCH(request: NextRequest, { params }: RouteParams): Promise<Response> {
  return handle(request, (await params).path);
}
export async function DELETE(request: NextRequest, { params }: RouteParams): Promise<Response> {
  return handle(request, (await params).path);
}
