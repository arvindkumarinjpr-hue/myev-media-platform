import { Test, type TestingModule } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { UNREACHABLE_REDIS_URL } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { BackgroundJobsService } from "../src/modules/background-jobs/background-jobs.service";
import { SHUTDOWN_TRACKER } from "../src/shutdown/shutdown.module";

// See apps/worker's identical helper for why this is safe/established.
function activeHandleCount(): number {
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
  return (proc._getActiveHandles?.() ?? []).length;
}

/**
 * DEFECT-1F-001 — real Postgres + real Redis (or a deliberately
 * unreachable one). UNREACHABLE_REDIS_URL (`redis://127.0.0.1:1`, see
 * @myev/shared) is a DNS-free, deterministically-unreachable target used
 * by every unreachable-Redis test in this repo (Module 6 Phase 6.5-A):
 * loopback needs no resolver and port 1 has no listener, so every
 * connection attempt fails immediately with `ECONNREFUSED` and ioredis
 * retries it forever — without the DNS nondeterminism the earlier
 * `redis://redis:1` had on CI runners.
 *
 * BackgroundJobsService.getQueue() constructs redisConnection lazily,
 * on first call. Constructing it alone is NOT enough to exercise the
 * pathological case this defect concerns — proven empirically: a
 * connection that has never been asked to send a command quits cleanly
 * and quickly even while mid-reconnect-retry, because there is no
 * in-flight command for maxRetriesPerRequest:null to ever leave
 * dangling. A genuine fire-and-forget command (never awaited by the
 * test itself, so it cannot hang the test) reproduces the real
 * production scenario — an enqueue() call whose queue.add() is still
 * pending when shutdown begins — via the same internals-access pattern
 * already established in apps/worker's retry-dead-letter.e2e-spec.ts.
 */
describe("API (e2e) — DEFECT-1F-001 bounded shutdown", () => {
  process.env.REDIS_SHUTDOWN_DEADLINE_MS = process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "2000";

  const originalRedisUrl = process.env.REDIS_URL;
  afterEach(() => {
    process.env.REDIS_URL = originalRedisUrl;
  });

  async function bootstrap(): Promise<{ moduleRef: TestingModule; app: INestApplication }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    return { moduleRef, app };
  }

  function constructRedisConnection(app: INestApplication): void {
    const service = app.get(BackgroundJobsService);
    const internals = service as unknown as { getQueue: (queueName: string) => unknown };
    internals.getQueue("SYSTEM");
  }

  // Deliberately fire-and-forget (never awaited) — against a genuinely
  // unreachable Redis this command never settles, exactly mirroring
  // what a real enqueue() would leave pending. Awaiting it here would
  // hang the test itself, not just the code under test.
  function issuePendingCommand(app: INestApplication): void {
    const service = app.get(BackgroundJobsService);
    const internals = service as unknown as { redisConnection?: { ping: () => Promise<unknown> } };
    internals.redisConnection?.ping().catch(() => undefined);
  }

  it("healthy Redis: shuts down gracefully with no forced fallback — the healthy-path regression proof", async () => {
    const { app } = await bootstrap();
    constructRedisConnection(app);
    const tracker = app.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

    await app.close();

    expect(tracker.getAll().get("BackgroundJobsService")).toBe("GRACEFUL");
    expect(tracker.hasFailure()).toBe(false);
  });

  it("Redis genuinely unreachable: bounds shutdown to approximately the configured deadline and force-closes redisConnection", async () => {
    process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
    const { app } = await bootstrap();
    constructRedisConnection(app);
    issuePendingCommand(app);
    const tracker = app.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

    const start = Date.now();
    await app.close();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(6_000);
    expect(tracker.getAll().get("BackgroundJobsService")).toBe("FORCED");
  }, 15_000);

  it("Redis genuinely unreachable: repeated forced-shutdown cycles do not grow active handles", async () => {
    process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
    const handleCounts: number[] = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const { app } = await bootstrap();
      constructRedisConnection(app);
      issuePendingCommand(app);
      await app.close();
      // 2.5s > ioredis's default max reconnect backoff (2s): with the
      // deterministic UNREACHABLE_REDIS_URL target every attempt fails
      // immediately with ECONNREFUSED and schedules one short backoff
      // timer, so a shorter settle could snapshot mid-backoff.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      handleCounts.push(activeHandleCount());
    }

    // Rejects UNBOUNDED, monotonic growth (a real leak is dozens of
    // handles — the earlier EAI_AGAIN DNS-retry storm produced ~39); a
    // small bounded residue from libuv/Jest internals is expected.
    const growth = handleCounts[handleCounts.length - 1] - handleCounts[0];
    expect(growth).toBeLessThanOrEqual(3);
  }, 40_000);

  it("Redis genuinely unreachable: produces no unhandled promise rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      const { app } = await bootstrap();
      constructRedisConnection(app);
      issuePendingCommand(app);
      await app.close();
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 15_000);
});
