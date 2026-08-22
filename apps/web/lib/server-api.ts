import { cookies } from "next/headers";
import { backendUrl } from "./config";
import { ACCESS_TOKEN_COOKIE } from "./auth-cookies";
import { ApiError } from "./errors";

/** Server Components read the httpOnly cookie and call the backend directly — no self-referential round-trip through /api/backend, which exists only for the browser. No refresh-on-401 here: a Server Component render is a single request, so an expired token just surfaces as a redirect via the layout's own auth check, same as any other unauthenticated visit. */
export async function serverGet<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_TOKEN_COOKIE)?.value;
  if (!accessToken) {
    throw new ApiError(401, { code: "AUTH_TOKEN_INVALID", message: "Not signed in." });
  }

  const workspaceId = path.startsWith("workspaces/") ? path.split("/")[1] : undefined;
  const res = await fetch(`${backendUrl()}/api/v1/${path}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(workspaceId ? { "X-Workspace-Id": workspaceId } : {}),
    },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, payload);
  }
  return payload.data as T;
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  return Boolean(cookieStore.get(ACCESS_TOKEN_COOKIE)?.value);
}
