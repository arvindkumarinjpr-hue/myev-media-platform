// Mirrors the backend's own error-body convention exactly (flat
// {code, message}, never nested under {error: {...}} — see every Module 1/2
// controller): this is the one shape every 4xx/5xx response takes.
export interface ApiErrorBody {
  code: string;
  message: string;
  details?: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: string[];

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

const FALLBACK_MESSAGES: Record<number, string> = {
  401: "Your session has expired. Please sign in again.",
  403: "You don't have permission to do that.",
  404: "Not found.",
  429: "Too many requests. Please wait a moment and try again.",
};

/** Never leaks a raw API/Prisma error string to the UI — always resolves to a stable, presentable message. */
export function friendlyMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message || FALLBACK_MESSAGES[error.status] || "Something went wrong. Please try again.";
  }
  return "Something went wrong. Please try again.";
}

/**
 * Most error bodies already match the app's own {code, message: string}
 * convention (every hand-written controller error, e.g. auth's token/
 * reuse errors). class-validator DTO violations (e.g. ResetPasswordDto's
 * `@MinLength(8)` on newPassword) bypass that convention entirely and
 * arrive as Nest's own default shape instead — {statusCode, message:
 * string[], error} — before the request ever reaches a controller.
 * Normalizing here, once, keeps every call site free to just do
 * `new ApiError(status, normalizeApiErrorBody(payload))` without needing
 * to know which shape a given endpoint happens to produce.
 */
export function normalizeApiErrorBody(payload: unknown): ApiErrorBody {
  const body = (payload ?? {}) as Record<string, unknown>;
  const rawMessage = body.message;
  const message = Array.isArray(rawMessage) ? rawMessage.filter((m) => typeof m === "string").join(" ") : typeof rawMessage === "string" ? rawMessage : "";
  const code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : "UNKNOWN_ERROR";
  return { code, message };
}

export function isStaleLockConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "KNOWLEDGE_CONFLICT";
}
