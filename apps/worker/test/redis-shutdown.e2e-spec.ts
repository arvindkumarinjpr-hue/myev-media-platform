import { Test, type TestingModule } from "@nestjs/testing";
import type { ShutdownOutcomeTracker } from "@myev/shared";
import { UNREACHABLE_REDIS_URL } from "@myev/shared";
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
 * unreachable one), no mocking. UNREACHABLE_REDIS_URL (`redis://127.0.0.1:1`,
 * see @myev/shared) is a DNS-free, deterministically-unreachable target:
 * loopback needs no resolver (Module 6 Phase 6.5-A removed the earlier
 * `redis://redis:1`, whose hostname a CI runner sometimes failed to
 * resolve with a transient `EAI_AGAIN`, making ioredis retry DNS forever
 * and leaving lookup handles alive), and port 1 has no listener so every
 * attempt fails immediately with `ECONNREFUSED` — which ioredis's own
 * default retryStrategy retries forever, identical in effect to a fully
 * unreachable host.
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
    process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
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
    // DEFECT-1F-006 added a 4th bootstrap/shutdown-participating manager
    // (BackgroundJobReconciliationManager) to this same AppModule, each
    // bounded at REDIS_SHUTDOWN_DEADLINE_MS and run sequentially across
    // modules (not in parallel — see BullMqWorkerManager's own doc
    // comment) — worst case is now ~4 * 2000ms = 8000ms just for
    // shutdown forcing, so the previous 8000ms ceiling (sized for 2-3
    // managers) is no longer a safe margin.
    expect(elapsed).toBeLessThan(12_000);

    const outcomes = tracker.getAll();
    expect(outcomes.get("BullMqWorkerManager")).toBe("FORCED");
    expect(outcomes.get("SchedulerTickManager")).toBe("FORCED");

    await cleanupHeartbeat(moduleRef);
  }, 25_000);

  it("Redis genuinely unreachable: repeated forced-shutdown cycles do not grow active handles", async () => {
    process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
    const handleCounts: number[] = [];

    for (let cycle = 0; cycle < 3; cycle++) {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      await moduleRef.init();
      await moduleRef.close();
      await cleanupHeartbeat(moduleRef);
      // Lets any fire-and-forget force-close work (worker.close(true))
      // settle before measuring — this asserts the steady state after
      // each cycle, not the instant close() itself returns. 2.5s is
      // deliberately longer than ioredis's default max reconnect backoff
      // (2s): with the deterministic UNREACHABLE_REDIS_URL target every
      // connection attempt fails immediately with ECONNREFUSED and
      // schedules one short backoff timer, so a shorter wait could
      // snapshot mid-backoff and see a transient extra handle.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      handleCounts.push(activeHandleCount());
    }

    // Not exact equality — a small bounded fluctuation from Jest's own
    // machinery + libuv internals is expected. What this rejects is
    // UNBOUNDED, monotonic growth across cycles — a real connection leak
    // would be dozens of handles (the earlier EAI_AGAIN DNS-retry storm
    // produced a growth of ~39); 3 is well inside "bounded".
    const growth = handleCounts[handleCounts.length - 1] - handleCounts[0];
    expect(growth).toBeLessThanOrEqual(3);
    // DEFECT-1F-006's 4th manager adds real, bounded time to both
    // bootstrap and shutdown of each of the 3 cycles here (see the
    // identical comment on the test above) — 40_000ms is no longer
    // reliably enough headroom.
  }, 60_000);

  it("Redis genuinely unreachable: produces no unhandled promise rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
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
