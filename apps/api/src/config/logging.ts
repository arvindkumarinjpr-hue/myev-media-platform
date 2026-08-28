/**
 * Module 6 Phase 6.5-A — the redaction contract for the API's structured
 * request/response logs (nestjs-pino / pino-http).
 *
 * `pino-std-serializers` logs `req.headers` (Node lower-cases every
 * incoming header name) and `res.headers` = `res.getHeaders()` (also
 * lower-cased). These three paths therefore match regardless of how a
 * client or Express cased the header. Each whole value is replaced with
 * `LOG_REDACT_CENSOR` — never a prefix/suffix, never the length. Nothing
 * else about a log line is affected (request_id, correlation_id, method,
 * url, status, latency, and every non-sensitive header still log
 * normally). This governs only what is logged; it does not touch cookie
 * flags, the refresh flow, session semantics or access-token handling.
 */
export const LOG_REDACT_CENSOR = "[REDACTED]";

export function logRedactPaths(): string[] {
  return [
    // Request: the caller's bearer token and its raw Cookie header
    // (which carries the httpOnly refresh_token).
    "req.headers.authorization",
    "req.headers.cookie",
    // Response: the Set-Cookie header set by auth login / refresh, whose
    // value is the plaintext refresh token. Bracket notation because the
    // key contains a hyphen; a plain (non-wildcard) path redacts the
    // whole value whether it is a string or an array of strings.
    'res.headers["set-cookie"]',
  ];
}

export function logRedactOptions(): { paths: string[]; censor: string; remove: boolean } {
  return { paths: logRedactPaths(), censor: LOG_REDACT_CENSOR, remove: false };
}
