import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { UNREACHABLE_REDIS_URL } from "@myev/shared";
import path from "path";
import { PrismaService } from "../src/prisma/prisma.service";

/**
 * DEFECT-1F-001 — real OS signals to a real, separately-spawned worker
 * process (not Test.createTestingModule, which never exercises
 * enableShutdownHooks()'s actual signal-to-close() wiring at all). This
 * is the one test category that can prove the apps/api gap this defect
 * also fixes (enableShutdownHooks() was previously never called there)
 * actually matters: without it, a real SIGTERM never triggers
 * OnModuleDestroy in the first place.
 *
 * Readiness (DEFECT-1F-001 signal-handler readiness race fix): every
 * test below waits for the child's own APPLICATION_READY marker on
 * stdout, never for the worker_heartbeats row alone. The heartbeat row
 * is written during OnApplicationBootstrap, which can complete before
 * NestFactory.createApplicationContext() itself resolves (a LATER
 * module's own bootstrap hook may still be in flight) — i.e. before
 * main.ts's own signal handlers are armed. APPLICATION_READY is only
 * ever printed after signal handlers are registered AND bootstrap has
 * fully completed, so it is the only correct readiness signal for a
 * test that immediately sends a real OS signal.
 */
describe("Worker (e2e) — DEFECT-1F-001 real SIGTERM/SIGINT", () => {
  const WORKER_ROOT = path.resolve(__dirname, "..");
  let prisma: PrismaService;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function spawnWorker(applicationVersion: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn("node", ["-r", "ts-node/register/transpile-only", "src/main.ts"], {
      cwd: WORKER_ROOT,
      env: {
        ...process.env,
        WORKER_QUEUES: "SYSTEM",
        WORKER_APPLICATION_VERSION: applicationVersion,
        WORKER_HEARTBEAT_INTERVAL_MS: "2000",
        REDIS_SHUTDOWN_DEADLINE_MS: "2000",
        SCHEDULER_REGISTRATION_TIMEOUT_MS: "2000",
        LOG_LEVEL: "error",
        ...extraEnv,
      },
    });
  }

  interface ExitResult {
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }

  function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<ExitResult> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ code: null, signal: null, timedOut: true });
      }, timeoutMs);
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });
  }

  // DEFECT-1F-001 signal-handler readiness race fix — replaces the old
  // worker_heartbeats-row-based wait (see this file's own class doc
  // comment for why that was unsafe). Watches the child's own stdout for
  // its self-reported APPLICATION_READY marker, printed by main.ts only
  // once signal handlers are armed AND bootstrap has fully completed —
  // the only point at which sending a real signal is safe to reason
  // about deterministically.
  function waitForReady(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;
      const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("utf8");
        if (settled) return;
        if (buffer.includes('"event":"APPLICATION_READY"')) {
          settled = true;
          clearTimeout(timer);
          child.stdout.off("data", onData);
          resolve();
        }
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.stdout.off("data", onData);
        reject(new Error(`worker did not report APPLICATION_READY within ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", onData);
    });
  }

  function collectStderr(child: ChildProcessWithoutNullStreams): { text: () => string } {
    let buffer = "";
    child.stderr.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
    });
    return { text: () => buffer };
  }

  const spawnedProcesses: ChildProcessWithoutNullStreams[] = [];
  afterEach(async () => {
    for (const child of spawnedProcesses.splice(0)) {
      if (!child.killed) child.kill("SIGKILL");
    }
  });

  it.each(["SIGTERM", "SIGINT"] as const)("%s against a healthy Redis: bounded exit via correct signal termination, no external kill needed", async (signal) => {
    const applicationVersion = `e2e-signal-${signal.toLowerCase()}-${Date.now()}`;
    const child = spawnWorker(applicationVersion);
    spawnedProcesses.push(child);

    await waitForReady(child, 15_000);

    child.kill(signal);
    const result = await waitForExit(child, 15_000);

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe(signal);
    expect(result.code).toBeNull();

    await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
  }, 30_000);

  it("SIGTERM against a genuinely unreachable Redis: still exits within the bounded deadline via correct signal termination (FORCED still terminates via the signal, not a distinct exit code — see main.ts's own policy comment)", async () => {
    const applicationVersion = `e2e-signal-broken-${Date.now()}`;
    const child = spawnWorker(applicationVersion, { REDIS_URL: UNREACHABLE_REDIS_URL });
    spawnedProcesses.push(child);

    await waitForReady(child, 15_000);

    child.kill("SIGTERM");
    // DEFECT-1F-006 added a 4th bootstrap/shutdown-participating manager
    // (BackgroundJobReconciliationManager) to this same AppModule, bound
    // by the identical REDIS_SHUTDOWN_DEADLINE_MS/SCHEDULER_REGISTRATION_TIMEOUT_MS
    // (2000ms each) and run sequentially across modules, not in parallel
    // (see redis-shutdown.e2e-spec.ts's identical comment) — worst case
    // shutdown is now ~4 * 2000ms = 8000ms, and the previous 15_000ms
    // budget (sized for 2-3 managers, with no margin for real-world
    // scheduling jitter under load) is no longer reliably enough.
    const result = await waitForExit(child, 20_000);

    expect(result.timedOut).toBe(false);
    expect(result.signal).toBe("SIGTERM");
    expect(result.code).toBeNull();

    await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
  }, 40_000);

  describe("DEFECT-1F-001 FINAL SIGNAL ERROR-HANDLING FIX", () => {
    it.each(["SIGTERM", "SIGINT"] as const)(
      "%s while a lifecycle provider throws during app.close(): exits deterministically with code 1, no unhandled-rejection/uncaught-exception path, original signal NOT re-delivered",
      async (signal) => {
        const applicationVersion = `e2e-signal-failure-${signal.toLowerCase()}-${Date.now()}`;
        const child = spawnWorker(applicationVersion, { SIMULATE_SHUTDOWN_FAILURE: "true" });
        spawnedProcesses.push(child);
        const stderr = collectStderr(child);

        await waitForReady(child, 15_000);

        child.kill(signal);
        const result = await waitForExit(child, 15_000);

        expect(result.timedOut).toBe(false);
        expect(result.code).toBe(1);
        expect(result.signal).toBeNull();

        const output = stderr.text();
        expect((output.match(/APPLICATION_SHUTDOWN_FAILED/g) ?? []).length).toBe(1);
        expect(output).toContain('"service":"myev-worker"');
        expect(output).toContain(`"signal":"${signal}"`);
        expect(output).not.toMatch(/UnhandledPromiseRejectionWarning/i);
        expect(output).not.toMatch(/Unhandled promise rejection/i);
        expect(output).not.toMatch(/uncaught exception/i);

        await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
      },
      30_000,
    );

    it("ShutdownOutcomeTracker already contains FAILED while app.close() itself resolves cleanly: still exits 1", async () => {
      const applicationVersion = `e2e-signal-tracker-failure-${Date.now()}`;
      const child = spawnWorker(applicationVersion, { SIMULATE_TRACKER_FAILURE: "true" });
      spawnedProcesses.push(child);

      await waitForReady(child, 15_000);

      child.kill("SIGTERM");
      const result = await waitForExit(child, 15_000);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();

      await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
    }, 30_000);

    it("near-simultaneous SIGTERM + SIGINT: the shutdown body executes exactly once, not twice", async () => {
      const applicationVersion = `e2e-signal-race-${Date.now()}`;
      const child = spawnWorker(applicationVersion, { SIMULATE_SHUTDOWN_FAILURE: "true" });
      spawnedProcesses.push(child);
      const stderr = collectStderr(child);

      await waitForReady(child, 15_000);

      child.kill("SIGTERM");
      child.kill("SIGINT");
      const result = await waitForExit(child, 15_000);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);

      const occurrences = (stderr.text().match(/APPLICATION_SHUTDOWN_FAILED/g) ?? []).length;
      expect(occurrences).toBe(1);

      await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
    }, 30_000);

    it("regression guard: SIGTERM sent with zero delay after APPLICATION_READY is never dropped — signal handling is already armed by the moment readiness is observed", async () => {
      // This is the exact race DEFECT-1F-001's signal-handler readiness
      // fix closed: previously, APPLICATION_READY did not exist and
      // readiness was inferred from the worker_heartbeats row, which
      // could become visible before signal handlers were registered
      // (WorkerHeartbeatService's OnApplicationBootstrap hook could
      // complete before a later module's own — e.g. OutboxRelayManager's
      // bounded Redis registration). A SIGTERM sent immediately after
      // that stale readiness signal could silently fall through to the
      // OS default disposition instead of running app.close(). Sending
      // SIGTERM with zero delay after APPLICATION_READY — main.ts's own
      // readiness invariant — must always be caught, deterministically,
      // with no sleep needed to "wait out" the race.
      const applicationVersion = `e2e-signal-readiness-race-${Date.now()}`;
      const child = spawnWorker(applicationVersion, { SIMULATE_SHUTDOWN_FAILURE: "true" });
      spawnedProcesses.push(child);
      const stderr = collectStderr(child);

      await waitForReady(child, 15_000);
      child.kill("SIGTERM");
      const result = await waitForExit(child, 15_000);

      expect(result.timedOut).toBe(false);
      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(stderr.text()).toContain("APPLICATION_SHUTDOWN_FAILED");

      await prisma.workerHeartbeat.deleteMany({ where: { applicationVersion } });
    }, 30_000);
  });
});
