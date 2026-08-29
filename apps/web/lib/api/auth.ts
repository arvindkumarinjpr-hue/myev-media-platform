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

/**
 * Always resolves (never throws) on a normal 200 — the backend itself is
 * enumeration-safe (identical generic message whether or not the account
 * exists), so this never distinguishes "account exists" from "it
 * doesn't" either. A thrown ApiError here means a genuine system-level
 * problem (validation/rate-limit/network), never an enumeration signal.
 */
export async function forgotPassword(email: string): Promise<{ message: string }> {
  const res = await fetch("/api/auth/forgot-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { ApiError, normalizeApiErrorBody } = await import("../errors");
    throw new ApiError(res.status, normalizeApiErrorBody(payload));
  }
  return payload.data;
}

/**
 * The one operation behind both /reset-password and /activate — the
 * backend itself treats password reset and account activation as the
 * same underlying "consume a one-time token, set a password" action
 * (AuthService.resetPassword's own doc comment), distinguished only by
 * the token's own stored `purpose`. Never returns a session/token: the
 * caller is never auto-logged-in by this call.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const res = await fetch("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, newPassword }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const { ApiError, normalizeApiErrorBody } = await import("../errors");
    throw new ApiError(res.status, normalizeApiErrorBody(payload));
  }
}
