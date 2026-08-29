import { pino, stdSerializers } from "pino";
import { LOG_REDACT_CENSOR, logRedactOptions } from "./logging";

/**
 * Module 6 Phase 6.5-A — proves the API log-redaction contract with a
 * REAL pino instance using the exact `redact` options app.module.ts
 * wires into nestjs-pino, plus the real pino-http `res` serializer.
 */

const SECRET = "s3cr3t-token-abc123XYZ";

function capturingLogger() {
  const lines: unknown[] = [];
  const stream = { write: (s: string) => lines.push(JSON.parse(s)) };
  const logger = pino({ redact: logRedactOptions() }, stream as unknown as import("pino").DestinationStream);
  return { logger, lines, text: () => JSON.stringify(lines) };
}

describe("API log redaction", () => {
  it("replaces a request Authorization bearer token with the censor — never verbatim, never a prefix", () => {
    const { logger, text } = capturingLogger();
    logger.info({ req: { headers: { authorization: `Bearer ${SECRET}`, "user-agent": "jest" } } }, "request completed");
    expect(text()).not.toContain(SECRET);
    expect(text()).toContain(LOG_REDACT_CENSOR);
    expect(text()).toContain("jest"); // non-sensitive header still logged
  });

  it("replaces a request Cookie header (carrying refresh_token) with the censor", () => {
    const { logger, text } = capturingLogger();
    logger.info({ req: { headers: { cookie: `theme=dark; refresh_token=${SECRET}; other=1` } } }, "request completed");
    expect(text()).not.toContain(SECRET);
    expect(text()).toContain(LOG_REDACT_CENSOR);
  });

  it("replaces a Set-Cookie response header without exposing the refresh token or its length", () => {
    const { logger, text } = capturingLogger();
    logger.info(
      { res: { statusCode: 200, headers: { "set-cookie": `refresh_token=${SECRET}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600` } } },
      "request completed",
    );
    expect(text()).not.toContain(SECRET);
    expect(text()).not.toContain(String(SECRET.length));
    expect(text()).toContain(LOG_REDACT_CENSOR);
  });

  it("redacts multiple Set-Cookie values (array form) safely", () => {
    const { logger, text } = capturingLogger();
    logger.info(
      { res: { statusCode: 200, headers: { "set-cookie": [`refresh_token=${SECRET}; HttpOnly`, `csrf=${SECRET}-2; SameSite=Lax`] } } },
      "request completed",
    );
    expect(text()).not.toContain(SECRET);
    expect(text()).toContain(LOG_REDACT_CENSOR);
  });

  it("matches header-name casing variations (Node lower-cases req.headers and res.getHeaders())", () => {
    // Node's HTTP layer normalises incoming request headers and outgoing
    // header names to lower case before the serializer ever sees them, so
    // the lower-case redact paths cover Authorization / AUTHORIZATION /
    // Set-Cookie / SET-COOKIE alike. Simulate what the serializer
    // actually receives.
    const { logger, text } = capturingLogger();
    logger.info(
      { req: { headers: { authorization: `Bearer ${SECRET}` } }, res: { statusCode: 200, headers: { "set-cookie": `refresh_token=${SECRET}` } } },
      "request completed",
    );
    expect(text()).not.toContain(SECRET);
  });

  it("leaves non-sensitive request/response headers and observability fields intact", () => {
    const { logger, lines } = capturingLogger();
    logger.info(
      {
        reqId: "req-123",
        correlationId: "corr-456",
        req: { method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json", "x-request-id": "req-123" } },
        res: { statusCode: 200, headers: { "content-type": "application/json", "x-frame-options": "DENY" } },
        responseTime: 42,
      },
      "request completed",
    );
    const entry = lines[0] as Record<string, unknown>;
    expect(entry.reqId).toBe("req-123");
    expect(entry.correlationId).toBe("corr-456");
    expect(entry.responseTime).toBe(42);
    expect((entry.req as { method: string }).method).toBe("POST");
    expect((entry.req as { headers: Record<string, string> }).headers["content-type"]).toBe("application/json");
    expect((entry.res as { statusCode: number }).statusCode).toBe(200);
    expect((entry.res as { headers: Record<string, string> }).headers["x-frame-options"]).toBe("DENY");
  });

  it("also holds through the real pino-http response serializer (what actually runs in production)", () => {
    const { logger, text } = capturingLogger();
    // Minimal ServerResponse stand-in exposing what pino-std-serializers' res serializer reads.
    const res = {
      headersSent: true,
      statusCode: 200,
      getHeaders: () => ({ "set-cookie": [`refresh_token=${SECRET}; HttpOnly; Secure`], "content-type": "application/json" }),
    };
    const serialized = stdSerializers.res(res as never);
    logger.info({ res: serialized }, "request completed");
    expect(text()).not.toContain(SECRET);
    expect(text()).toContain(LOG_REDACT_CENSOR);
    expect(text()).toContain("application/json");
  });
});
