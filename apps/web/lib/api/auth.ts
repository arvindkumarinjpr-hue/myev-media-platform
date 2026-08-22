import type { CurrentUser } from "../types";

export async function login(email: string, password: string): Promise<{ user: CurrentUser }> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { ApiError } = await import("../errors");
    throw new ApiError(res.status, payload);
  }
  return payload.data;
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST" });
}
