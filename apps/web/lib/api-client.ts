import { ApiError, type ApiErrorBody } from "./errors";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/backend/${path}`, {
    ...init,
    headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined") {
      // The proxy's own refresh-on-401 retry already failed by the time a
      // Client Component sees this — the session is genuinely over.
      // Every caller would otherwise need to remember to check for this
      // themselves; handling it once here means none of them do.
      window.location.href = "/login";
    }
    throw new ApiError(res.status, payload as ApiErrorBody);
  }
  return (payload as { data: T }).data;
}

export const apiClient = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
