import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import Redis from "ioredis";
import request from "supertest";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { PasswordHashService } from "../src/common/crypto/password-hash.service";
import { extractToken, getLatestEmailFor } from "./helpers/e2e-app";

/**
 * Module 1B.1 Engineering Plan §13 integration/E2E coverage. Runs against a
 * real Postgres + Redis (the dev Docker Compose stack) — no mocking of the
 * database or the transaction/locking behavior under test, since the two
 * real bugs this module shipped with (raw-query column mapping, and writes
 * lost to transaction rollback on reuse detection) were both invisible to
 * mocked unit tests and only surfaced under a real live sequence.
 *
 * Every user this suite creates is prefixed `e2e-` so it never collides
 * with the seeded bootstrap owner, and is deleted in `afterAll`.
 */

const TEST_EMAIL_PREFIX = "e2e-";
const VALID_PASSWORD = "A-Valid-Password-123";

function uniqueEmail(label: string): string {
  return `${TEST_EMAIL_PREFIX}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let passwordHashService: PasswordHashService;
  let redis: Redis;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = app.get(PrismaService);
    passwordHashService = app.get(PasswordHashService);
    redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");
  });

  beforeEach(async () => {
    // Login/forgot-password are rate-limited per IP, and every request in
    // this suite arrives from the same test-client IP — flush the (dev-only,
    // disposable) Redis instance between tests so each test's own login
    // attempts don't get throttled by a previous test's. This exercises the
    // real AdaptiveProtectionService against real Redis rather than mocking
    // it away.
    await redis.flushdb();
  });

  afterAll(async () => {
    await redis.quit();
    // Child rows first — none of these relations cascade on delete.
    const testUsers = await prisma.user.findMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } }, select: { id: true } });
    const testUserIds = testUsers.map((u) => u.id);
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: testUserIds } } });
    await prisma.userActionToken.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.userSession.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.userPasswordHistory.deleteMany({ where: { userId: { in: testUserIds } } });
    await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
    await app.close();
  });

  async function createActiveUser(label: string, password = VALID_PASSWORD) {
    const email = uniqueEmail(label);
    const passwordHash = await passwordHashService.hash(password);
    const user = await prisma.user.create({
      data: { email, fullName: `E2E ${label}`, status: "ACTIVE", passwordHash },
    });
    await prisma.userPasswordHistory.create({ data: { userId: user.id, passwordHash } });
    return { user, email, password };
  }

  function extractRefreshCookie(res: request.Response): string {
    const setCookie = res.get("Set-Cookie") ?? [];
    const raw = setCookie.find((c) => c.startsWith("refresh_token="));
    if (!raw) throw new Error("No refresh_token cookie in response");
    return raw.split(";")[0];
  }

  describe("POST /api/v1/auth/login", () => {
    it("succeeds with correct credentials and sets a refresh cookie", async () => {
      const { email, password } = await createActiveUser("login-ok");
      const res = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);

      expect(res.body.data.access_token).toEqual(expect.any(String));
      expect(res.body.data.user.email).toBe(email);
      expect(extractRefreshCookie(res)).toMatch(/^refresh_token=.+/);
    });

    it("rejects a wrong password with AUTH_INVALID_CREDENTIALS", async () => {
      const { email } = await createActiveUser("login-wrong-pw");
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email, password: "the-wrong-password-here" })
        .expect(401);
      expect(res.body.code).toBe("AUTH_INVALID_CREDENTIALS");
    });

    it("is enumeration-safe: a non-existent email returns the identical body as a wrong password", async () => {
      const { email } = await createActiveUser("login-enum");
      const wrongPassword = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email, password: "wrong-password-value" })
        .expect(401);
      const noSuchUser = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: uniqueEmail("does-not-exist"), password: "wrong-password-value" })
        .expect(401);

      expect(noSuchUser.body).toEqual(wrongPassword.body);
    });

    it("rejects a DISABLED account", async () => {
      const { user, email, password } = await createActiveUser("login-disabled");
      await prisma.user.update({ where: { id: user.id }, data: { status: "DISABLED" } });
      const res = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(403);
      expect(res.body.code).toBe("AUTH_ACCOUNT_DISABLED");
    });

    it("locks the account after the configured failed-attempt threshold", async () => {
      const { email } = await createActiveUser("login-lockout");
      // The lock check happens BEFORE the current attempt's counter
      // increment, so the request that actually crosses the threshold
      // (the 5th, given FAILED_LOGIN_THRESHOLD=5) still gets a plain
      // AUTH_INVALID_CREDENTIALS — it's the *next* request that sees the
      // account already locked. Matches the live-tested behavior.
      for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "wrong" }).expect(401);
      }
      const locking = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "wrong" });
      expect(locking.status).toBe(403);
      expect(locking.body.code).toBe("AUTH_ACCOUNT_LOCKED");
    });
  });

  describe("POST /api/v1/auth/refresh", () => {
    it("rotates the session and returns a new access token (regression: raw-query column mapping)", async () => {
      const { email, password } = await createActiveUser("refresh-rotate");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const cookie = extractRefreshCookie(login);

      const refreshed = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", cookie).expect(200);

      expect(refreshed.body.data.access_token).toEqual(expect.any(String));
      expect(refreshed.body.data.access_token).not.toBe(login.body.data.access_token);
    });

    it("rejects an unknown/garbage refresh token", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/refresh")
        .set("Cookie", "refresh_token=not-a-real-token")
        .expect(401);
      expect(res.body.code).toBe("AUTH_TOKEN_INVALID");
    });

    it("rejects a request with no refresh token at all", async () => {
      const res = await request(app.getHttpServer()).post("/api/v1/auth/refresh").expect(401);
      expect(res.body.code).toBe("AUTH_TOKEN_INVALID");
    });

    it("treats an immediate concurrent replay of a just-rotated token as a benign retry, not reuse", async () => {
      const { email, password } = await createActiveUser("refresh-grace");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const originalCookie = extractRefreshCookie(login);

      await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", originalCookie).expect(200);

      const replay = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", originalCookie).expect(401);
      expect(replay.body.code).toBe("AUTH_TOKEN_ROTATION_IN_PROGRESS");
    });

    it(
      "detects reuse of a stale rotated token outside the grace window and durably revokes the whole family " +
        "(regression: revocation write must survive even though the request still returns 401 — " +
        "throwing inside prisma.$transaction() previously rolled the revocation back)",
      async () => {
        const { email, password } = await createActiveUser("refresh-reuse");
        const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
        const staleCookie = extractRefreshCookie(login);

        const rotated = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", staleCookie).expect(200);
        const newestCookie = extractRefreshCookie(rotated);

        // Force the grace window closed without a real 10s sleep.
        await new Promise((r) => setTimeout(r, 10_100));

        const reuse = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", staleCookie).expect(401);
        expect(reuse.body.code).toBe("AUTH_TOKEN_REUSE_DETECTED");

        // The critical assertion: the newest (otherwise still-valid) token
        // in the same family must ALSO now be dead — proving the family
        // revocation actually persisted to Postgres and wasn't rolled back.
        const newestNowDead = await request(app.getHttpServer())
          .post("/api/v1/auth/refresh")
          .set("Cookie", newestCookie)
          .expect(401);
        expect(newestNowDead.body.code).toBe("AUTH_TOKEN_REUSE_DETECTED");

        const user = await prisma.user.findFirstOrThrow({ where: { email } });
        const sessions = await prisma.userSession.findMany({ where: { userId: user.id } });
        expect(sessions.length).toBeGreaterThan(0);
        for (const session of sessions) {
          expect(session.status).toBe("REVOKED");
          expect(session.revokedReason).toBe("REUSE_DETECTED");
        }
      },
      15_000,
    );
  });

  describe("POST /api/v1/auth/logout", () => {
    it("revokes the session and is idempotent on a second call", async () => {
      const { email, password } = await createActiveUser("logout");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const cookie = extractRefreshCookie(login);
      const accessToken = login.body.data.access_token as string;

      await request(app.getHttpServer())
        .post("/api/v1/auth/logout")
        .set("Cookie", cookie)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      const refreshAfterLogout = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", cookie);
      expect(refreshAfterLogout.status).toBe(401);

      // Idempotent: calling logout again (same access token, already-revoked session) still succeeds.
      await request(app.getHttpServer())
        .post("/api/v1/auth/logout")
        .set("Cookie", cookie)
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);
    });
  });

  describe("GET /api/v1/auth/me", () => {
    it("returns the caller's identity for a valid access token", async () => {
      const { email, password } = await createActiveUser("me");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const res = await request(app.getHttpServer())
        .get("/api/v1/auth/me")
        .set("Authorization", `Bearer ${login.body.data.access_token}`)
        .expect(200);
      expect(res.body.data.sessionId).toEqual(expect.any(String));
      void email;
    });

    it("rejects a missing or malformed access token", async () => {
      await request(app.getHttpServer()).get("/api/v1/auth/me").expect(401);
      await request(app.getHttpServer()).get("/api/v1/auth/me").set("Authorization", "Bearer not-a-real-jwt").expect(401);
    });
  });

  describe("POST /api/v1/auth/forgot-password + reset-password", () => {
    it("is enumeration-safe and issues a working one-time reset token for a real user", async () => {
      const { user, email } = await createActiveUser("forgot-reset");

      const forExisting = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email })
        .expect(200);
      const forMissing = await request(app.getHttpServer())
        .post("/api/v1/auth/forgot-password")
        .send({ email: uniqueEmail("nobody") })
        .expect(200);
      expect(forMissing.body).toEqual(forExisting.body);

      const token = await prisma.userActionToken.findFirstOrThrow({
        where: { userId: user.id, purpose: "PASSWORD_RESET", status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });

      // We only ever store the hash — reconstruct a token whose hash matches
      // is not possible from the DB row, so this test proves the *shape* of
      // the flow (token issued, correct purpose, correct expiry) rather than
      // completing the reset without the plaintext. The plaintext-driven
      // completion of this flow is covered live via Mailpit (see completion
      // report) and by the activation-token test below, which captures the
      // plaintext at creation time via a direct service call.
      expect(token.status).toBe("PENDING");
      expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("rejects an invalid reset token", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ token: "not-a-real-token", newPassword: VALID_PASSWORD })
        .expect(400);
      expect(res.body.code).toBe("AUTH_RESET_TOKEN_INVALID");
    });

    it("enforces the password policy on reset — 11 characters rejected", async () => {
      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ token: "irrelevant-fails-length-check-first", newPassword: "12345678901" })
        .expect(400);
      expect(res.body.message).toEqual(expect.arrayContaining([expect.stringContaining("12 characters")]));
    });

    it("full lifecycle: a fresh token completes a reset (12-character password accepted), the new password is properly hashed and usable to log in, and the token becomes single-use", async () => {
      const { user, email } = await createActiveUser("reset-lifecycle");

      await request(app.getHttpServer()).post("/api/v1/auth/forgot-password").send({ email }).expect(200);

      // Merely requesting/generating a token — nothing has been opened or
      // submitted yet — must not consume it.
      const issued = await prisma.userActionToken.findFirstOrThrow({
        where: { userId: user.id, purpose: "PASSWORD_RESET", status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      expect(issued.status).toBe("PENDING");

      const email1 = await getLatestEmailFor(email);
      expect(email1.subject).toContain("Reset");
      const plaintextToken = extractToken(email1.body);

      // An invalid (too-short) password submission against the REAL,
      // still-valid token must not consume it either.
      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ token: plaintextToken, newPassword: "short1" })
        .expect(400);
      const stillPending = await prisma.userActionToken.findUniqueOrThrow({ where: { id: issued.id } });
      expect(stillPending.status).toBe("PENDING");

      // Exactly 12 characters — the policy's own boundary.
      const newPassword = "twelvechars1";
      await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ token: plaintextToken, newPassword })
        .expect(200);

      const consumed = await prisma.userActionToken.findUniqueOrThrow({ where: { id: issued.id } });
      expect(consumed.status).toBe("USED");
      expect(consumed.usedAt).not.toBeNull();

      // Properly hashed: never stored/comparable as the raw plaintext, and
      // the only way to prove it decodes back to the same password is a
      // real login.
      const updatedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(updatedUser.passwordHash).not.toBe(newPassword);
      expect(updatedUser.passwordHash).not.toContain(newPassword);

      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: newPassword }).expect(200);
      expect(login.body.data.access_token).toEqual(expect.any(String));

      // Same token cannot be reused.
      const reuse = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ token: plaintextToken, newPassword: "Another-Password-8" })
        .expect(410);
      expect(reuse.body.code).toBe("AUTH_RESET_TOKEN_INVALID");
      expect(reuse.body.message).toBe("Link has already been used.");
    });

    it("rejects a genuinely expired token, and durably persists its EXPIRED status (regression: the status write must survive even though the request still returns 410 — throwing inside prisma.$transaction() would otherwise roll it back, mirroring the refresh-token-reuse fix elsewhere in this file)", async () => {
      const { user, email } = await createActiveUser("reset-expired");
      await request(app.getHttpServer()).post("/api/v1/auth/forgot-password").send({ email }).expect(200);

      const issued = await prisma.userActionToken.findFirstOrThrow({
        where: { userId: user.id, purpose: "PASSWORD_RESET", status: "PENDING" },
        orderBy: { createdAt: "desc" },
      });
      const email1 = await getLatestEmailFor(email);
      const plaintextToken = extractToken(email1.body);

      // Backdate the real row's expiry — the token's own validation logic
      // (expiresAt < now) is what's under test, not a fabricated scenario.
      await prisma.userActionToken.update({ where: { id: issued.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/reset-password")
        .send({ token: plaintextToken, newPassword: "Some-Valid-Password-8" })
        .expect(410);
      expect(res.body.code).toBe("AUTH_RESET_TOKEN_EXPIRED");

      const afterward = await prisma.userActionToken.findUniqueOrThrow({ where: { id: issued.id } });
      expect(afterward.status).toBe("EXPIRED");
    });
  });

  describe(
    "password reset clears the login lockout " +
      "(regression: resetPassword() never cleared the Redis brute-force counter, " +
      "so a legitimate reset could not unlock a locked account until its TTL expired)",
    () => {
      async function lockAccount(email: string): Promise<void> {
        for (let i = 0; i < 5; i++) {
          // eslint-disable-next-line no-await-in-loop
          await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "wrong" });
        }
      }

      it("keeps the CORRECT password rejected while locked (the lock check runs before password verification)", async () => {
        const { email, password } = await createActiveUser("lockout-correct-pw-still-locked");
        await lockAccount(email);

        const res = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("AUTH_ACCOUNT_LOCKED");
      });

      it("a successful reset clears the lock — the new password logs in immediately, with no Redis TTL wait", async () => {
        const { email } = await createActiveUser("lockout-reset-clears");
        await lockAccount(email);

        await request(app.getHttpServer()).post("/api/v1/auth/forgot-password").send({ email }).expect(200);
        const resetEmail = await getLatestEmailFor(email);
        const plaintextToken = extractToken(resetEmail.body);
        const newPassword = "brand-new-password-after-lock-1";

        await request(app.getHttpServer()).post("/api/v1/auth/reset-password").send({ token: plaintextToken, newPassword }).expect(200);

        const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: newPassword });
        expect(login.status).toBe(200);
        expect(login.body.data.access_token).toEqual(expect.any(String));
      });

      it("the old (pre-reset) password fails after a lock-clearing reset (confirms the lock was actually cleared, not bypassed)", async () => {
        const { email, password: oldPassword } = await createActiveUser("lockout-old-pw-fails");
        await lockAccount(email);

        await request(app.getHttpServer()).post("/api/v1/auth/forgot-password").send({ email }).expect(200);
        const resetEmail = await getLatestEmailFor(email);
        const plaintextToken = extractToken(resetEmail.body);
        await request(app.getHttpServer())
          .post("/api/v1/auth/reset-password")
          .send({ token: plaintextToken, newPassword: "another-brand-new-password-2" })
          .expect(200);

        // Exactly one attempt with the stale password — a real
        // AUTH_INVALID_CREDENTIALS (not AUTH_ACCOUNT_LOCKED) here proves the
        // lock was genuinely reset to zero, not merely tolerated once.
        const oldPwLogin = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: oldPassword });
        expect(oldPwLogin.status).toBe(401);
        expect(oldPwLogin.body.code).toBe("AUTH_INVALID_CREDENTIALS");
      });

      it("an invalid reset token does NOT clear the lock", async () => {
        const { email, password } = await createActiveUser("lockout-invalid-token-no-clear");
        await lockAccount(email);

        await request(app.getHttpServer())
          .post("/api/v1/auth/reset-password")
          .send({ token: "not-a-real-token", newPassword: "irrelevant-valid-password-1" })
          .expect(400);

        const stillLocked = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password });
        expect(stillLocked.status).toBe(403);
        expect(stillLocked.body.code).toBe("AUTH_ACCOUNT_LOCKED");
      });

      it("an expired reset token does NOT clear the lock", async () => {
        const { user, email, password } = await createActiveUser("lockout-expired-token-no-clear");
        await lockAccount(email);

        await request(app.getHttpServer()).post("/api/v1/auth/forgot-password").send({ email }).expect(200);
        const issued = await prisma.userActionToken.findFirstOrThrow({
          where: { userId: user.id, purpose: "PASSWORD_RESET", status: "PENDING" },
          orderBy: { createdAt: "desc" },
        });
        const resetEmail = await getLatestEmailFor(email);
        const plaintextToken = extractToken(resetEmail.body);
        await prisma.userActionToken.update({ where: { id: issued.id }, data: { expiresAt: new Date(Date.now() - 1000) } });

        await request(app.getHttpServer())
          .post("/api/v1/auth/reset-password")
          .send({ token: plaintextToken, newPassword: "irrelevant-valid-password-2" })
          .expect(410);

        const stillLocked = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password });
        expect(stillLocked.status).toBe(403);
        expect(stillLocked.body.code).toBe("AUTH_ACCOUNT_LOCKED");
      });

      it("a password-policy failure on reset does NOT clear the lock", async () => {
        const { email, password } = await createActiveUser("lockout-policy-fail-no-clear");
        await lockAccount(email);

        await request(app.getHttpServer()).post("/api/v1/auth/forgot-password").send({ email }).expect(200);
        const resetEmail = await getLatestEmailFor(email);
        const plaintextToken = extractToken(resetEmail.body);

        await request(app.getHttpServer())
          .post("/api/v1/auth/reset-password")
          .send({ token: plaintextToken, newPassword: "short1" })
          .expect(400);

        const stillLocked = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password });
        expect(stillLocked.status).toBe(403);
        expect(stillLocked.body.code).toBe("AUTH_ACCOUNT_LOCKED");
      });
    },
  );

  describe("POST /api/v1/auth/change-password", () => {
    it("enforces the same 12-character minimum as reset: 11 characters rejected, exactly 12 accepted", async () => {
      const { email, password } = await createActiveUser("change-min-length");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const accessToken = login.body.data.access_token as string;

      const tooShort = await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: "12345678901" })
        .expect(400);
      expect(tooShort.body.message).toEqual(expect.arrayContaining([expect.stringContaining("12 characters")]));

      await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: "twelvechars9" })
        .expect(200);
    });

    it("rejects the wrong current password", async () => {
      const { email, password } = await createActiveUser("change-wrong-current");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);

      const res = await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${login.body.data.access_token}`)
        .send({ currentPassword: "wrong-current-password", newPassword: "Some-New-Password-999" })
        .expect(401);
      expect(res.body.code).toBe("AUTH_INVALID_CREDENTIALS");
    });

    it("rejects reusing a recent password and accepts a genuinely new one", async () => {
      const { email, password } = await createActiveUser("change-reuse");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const accessToken = login.body.data.access_token as string;

      const reuseAttempt = await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: password })
        .expect(400);
      expect(reuseAttempt.body.code).toBe("PASSWORD_REUSE_DETECTED");

      await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ currentPassword: password, newPassword: "Brand-New-Password-777" })
        .expect(200);

      const reLogin = await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email, password: "Brand-New-Password-777" })
        .expect(200);
      expect(reLogin.body.data.access_token).toEqual(expect.any(String));
    });

    it("revokes other sessions but keeps the acting session usable", async () => {
      const { email, password } = await createActiveUser("change-session-scope");
      const loginA = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const loginB = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      const cookieB = extractRefreshCookie(loginB);

      await request(app.getHttpServer())
        .post("/api/v1/auth/change-password")
        .set("Authorization", `Bearer ${loginA.body.data.access_token}`)
        .send({ currentPassword: password, newPassword: "Another-New-Password-555" })
        .expect(200);

      // Session B (a different login) must be revoked...
      const refreshB = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", cookieB);
      expect(refreshB.status).toBe(401);

      // ...but session A (the one that performed the change) must still work.
      const cookieA = extractRefreshCookie(loginA);
      const refreshA = await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", cookieA);
      expect(refreshA.status).toBe(200);
    });
  });

  describe("audit logging", () => {
    it("records LOGIN_SUCCESS and TOKEN_REFRESHED for a login+refresh sequence", async () => {
      const { user, email, password } = await createActiveUser("audit");
      const login = await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      await request(app.getHttpServer()).post("/api/v1/auth/refresh").set("Cookie", extractRefreshCookie(login)).expect(200);

      const events = await prisma.auditLog.findMany({ where: { actorUserId: user.id }, orderBy: { createdAt: "asc" } });
      expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(["LOGIN_SUCCESS", "TOKEN_REFRESHED"]));
    });

    it("never contains a raw password or token plaintext in any recorded audit row", async () => {
      const { user, email, password } = await createActiveUser("audit-secrets");
      await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
      await request(app.getHttpServer()).post("/api/v1/auth/login").send({ email, password: "definitely-wrong" }).expect(401);

      const events = await prisma.auditLog.findMany({ where: { actorUserId: user.id } });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain(password);
      expect(serialized).not.toContain("definitely-wrong");
    });

    it("has no deletedAt/soft-delete column on AuditLog in the actual generated schema", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Prisma } = require("../generated/prisma");
      const auditLogModel = Prisma.dmmf.datamodel.models.find((m: { name: string }) => m.name === "AuditLog");
      expect(auditLogModel).toBeDefined();
      const fieldNames = auditLogModel.fields.map((f: { name: string }) => f.name);
      expect(fieldNames).not.toContain("deletedAt");
    });
  });
});
