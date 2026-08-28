import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LoggerModule } from "nestjs-pino";
import type { Response } from "express";
import { Res } from "@nestjs/common";
import request from "supertest";
import { LOG_REDACT_CENSOR, logRedactOptions } from "./logging";

/**
 * Module 6 Phase 6.5-A — a real HTTP round-trip through nestjs-pino /
 * pino-http using the exact `redact` options app.module.ts wires in.
 * Proves the auth secrets a real request/response carries never reach
 * the structured log, while the observability fields (method, url,
 * status, responseTime, reqId) do.
 */

const SECRET = "refresh-plaintext-9f8e7d6c5b4a";

@Controller()
class ProbeController {
  @Get("auth-echo")
  authEcho(@Res({ passthrough: true }) res: Response) {
    // Mirrors what AuthController.setRefreshCookie does.
    res.setHeader("Set-Cookie", `refresh_token=${SECRET}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Strict; Max-Age=1209600`);
    return { ok: true };
  }
}

describe("API log redaction (integration)", () => {
  let app: INestApplication;
  const logLines: Record<string, unknown>[] = [];

  beforeAll(async () => {
    const stream = { write: (s: string) => logLines.push(JSON.parse(s)) };

    @Module({
      imports: [
        LoggerModule.forRoot({
          pinoHttp: [
            { level: "info", customProps: () => ({ service: "myev-api" }), redact: logRedactOptions() },
            stream as never,
          ],
        }),
      ],
      controllers: [ProbeController],
    })
    class ProbeModule {}

    const moduleRef = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
    app = moduleRef.createNestApplication({ bufferLogs: true });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("does not leak the Authorization bearer token or the Set-Cookie refresh token, but keeps observability fields", async () => {
    logLines.length = 0;
    await request(app.getHttpServer())
      .get("/auth-echo")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Cookie", `theme=dark; refresh_token=${SECRET}`)
      .expect(200);

    const whole = JSON.stringify(logLines);
    expect(logLines.length).toBeGreaterThan(0);
    expect(whole).not.toContain(SECRET);
    expect(whole).toContain(LOG_REDACT_CENSOR);

    const completed = logLines.find((l) => typeof l.responseTime === "number" || (l.res as { statusCode?: number } | undefined)?.statusCode === 200);
    expect(completed).toBeDefined();
    const req = completed!.req as { method: string; url: string; headers: Record<string, string> };
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/auth-echo");
    expect(req.headers.authorization).toBe(LOG_REDACT_CENSOR);
    expect(req.headers.cookie).toBe(LOG_REDACT_CENSOR);
    const res = completed!.res as { statusCode: number; headers: Record<string, unknown> };
    expect(res.statusCode).toBe(200);
    expect(res.headers["set-cookie"]).toBe(LOG_REDACT_CENSOR);
  });
});
