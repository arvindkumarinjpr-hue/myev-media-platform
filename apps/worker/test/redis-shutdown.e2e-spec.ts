import { Test, type TestingModule } from "@nestjs/testing";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { SHUTDOWN_TRACKER } from "../src/shutdown/shutdown.module";

// process._getActiveHandles is a real, long-standing Node.js internal
// diagnostic API (undocumented, not in @types/node) — the same
// technique already established elsewhere in this project's own CI
// investigation for exactly this class of "no lingering handle" proof.
function activeHandleCount(): number {
  const proc = process as unknown as { _getActiveHandles?: () => unknown[] };
  return (proc._getActiveHandles?.() ?? []).length;
}

/**
 * DEFECT-1F-001 — real Postgres + real Redis (or a deliberately
 * unreachable one), no mocking. "redis://redis:1" is the exact
 * technique retry-dead-letter.e2e-spec.ts already established for a
 * genuinely-unreachable Redis (a real, resolvable hostname whose port
 * refuses — ioredis's own default retryStrategy retries this forever,
 * identical in effect to a fully unreachable host).
 */
describe("Worker (e2e) — DEFECT-1F-001 bounded shutdown", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";
  process.env.REDIS_SHUTDOWN_DEADLINE_MS = process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS ?? "2000";

  const originalRedisUrl = process.env.REDIS_URL;
  afterEach(() => {
    process.env.REDIS_URL = originalRedisUrl;
  });

  async function cleanupHeartbeat(moduleRef: TestingModule): Promise<void> {
    const prisma = moduleRef.get(PrismaService);
    const heartbeat = moduleRef.get(WorkerHeartbeatService);
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } }).catch(() => undefined);
  }

  it("healthy Redis: shuts down gracefully with no forced fallback — the healthy-path regression proof", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const tracker = moduleRef.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

    await moduleRef.close();

    const outcomes = tracker.getAll();
    expect(outcomes.get("BullMqWorkerManager")).toBe("GRACEFUL");
    expect(outcomes.get("SchedulerTickManager")).toBe("GRACEFUL");
    expect(tracker.hasFailure()).toBe(false);
  });

  it("Redis genuinely unreachable: bounds shutdown to approximately the configured deadline and force-closes both components", async () => {
    process.env.REDIS_URL = "redis://redis:1";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    const tracker = moduleRef.get<ShutdownOutcomeTracker>(SHUTDOWN_TRACKER);

    const start = Date.now();
    await moduleRef.close();
    const elapsed = Date.now() - start;

    // Bounded, not "eventually finished": REDIS_SHUTDOWN_DEADLINE_MS is
    // 2000ms — a generous multiple above that (not an exact ceiling,
    // since SchedulerTickManager's own DEFECT-1F-004 registration
    // timeout also runs during bootstrap, not shutdown) still proves
    // this is nowhere close to the unbounded hang the defect describes.
    expect(elapsed).toBeLessThan(8_000);

    const outcomes = tracker.getAll();
    expect(outcomes.get("BullMqWorkerManager")).toBe("FORCED");
    expect(outcomes.get("SchedulerTickManager")).toBe("FORCED");

    await cleanupHeartbeat(moduleRef);
  }, 20_000);

  it("Redis genuinely unreachable: repeated forced-shutdown cycles do not grow active handles", async () => {
    process.env.REDIS_URL = "redis://redis:1";
    const handleCounts: number[] = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      await moduleRef.close();
      await cleanupHeartbeat(moduleRef);
      // Lets any fire-and-forget force-close work (worker.close(true))
      // settle before measuring — this asserts the steady state after
      // each cycle, not the instant close() itself returns.
      await new Promise((resolve) => setTimeout(resolve, 300));
      handleCounts.push(activeHandleCount());
    }

    // Not exact equality — a small bounded fluctuation from Jest's own
    // machinery is expected; unbounded, monotonic growth across cycles
    // is what a real leak would look like, and is what this rejects.
    const growth = handleCounts[handleCounts.length - 1] - handleCounts[0];
    expect(growth).toBeLessThanOrEqual(2);
  }, 40_000);

  it("Redis genuinely unreachable: produces no unhandled promise rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      process.env.REDIS_URL = "redis://redis:1";
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      await moduleRef.close();
      await cleanupHeartbeat(moduleRef);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  }, 20_000);
});
