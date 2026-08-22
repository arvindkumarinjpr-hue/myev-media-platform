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

export function isStaleLockConflict(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.code === "KNOWLEDGE_CONFLICT";
}
