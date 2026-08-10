import { randomUUID } from "crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import path from "path";
import { Test, type TestingModule } from "@nestjs/testing";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { SYSTEM_PING_V1_MANIFEST } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { BackgroundJobReconciliationManager } from "../src/reconciliation/background-job-reconciliation.manager";
import type { BackgroundJob } from "../../api/generated/prisma";

/**
 * DEFECT-1F-006 — real spawned worker processes, real Postgres, real
 * Redis, no mocking, no synthetic rows. Deliberately separate from
 * background-job-reconciliation.e2e-spec.ts's direct-call/synthetic-row
 * tests: those correctly and deterministically prove the FENCING GUARD's
 * own SQL behavior in isolation, but cannot prove the actual defect
 * scenario end-to-end — a genuinely stalled or crashed OS process is
 * required, because (a) a real process crash can only be produced by a
 * real process, and (b) an ordinary in-process async stall would just be
 * caught by the EXISTING in-process Promise.race timeout mechanism
 * before an external reconciler ever got a chance to act, proving
 * nothing new. A REAL blocked event loop (this file's second test) is
 * the only way to prove the reconciler — not the engine's own timeout —
 * is what recovers a genuinely unresponsive attempt.
 *
 * Topology: a SPAWNED CHILD process hosts the crashing/stalling attempt
 * (real OS process, real BullMQ Worker, real pickup). The Jest process
 * itself hosts a SECOND, independent, healthy worker instance (via
 * Test.createTestingModule, same technique as every other e2e file in
 * this suite) that performs reconciliation and picks up the resulting
 * retry — modeling a realistic "one replica dies, another recovers its
 * work" topology, not a single-process simulation.
 */
describe("Worker (e2e) — DEFECT-1F-006 real process-crash / event-loop-stall recovery", () => {
  const WORKER_ROOT = path.resolve(__dirname, "..");

  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";
  process.env.REDIS_SHUTDOWN_DEADLINE_MS = process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS ?? "2000";
  // Suppresses this in-process module's OWN real reconciliation tick —
  // every test here drives findStaleCandidates/recoverCandidate directly
  // and deterministically, exactly as background-job-reconciliation.e2e-spec.ts does.
  process.env.BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS = "3600000";

  interface ReconciliationInternals {
    findStaleCandidates: () => Promise<BackgroundJob[]>;
    recoverCandidate: (candidate: BackgroundJob, correlationId: string) => Promise<"recovered" | "conflict-skipped">;
  }

  function spawnChildWorker(applicationVersion: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
    return spawn("node", ["-r", "ts-node/register/transpile-only", "src/main.ts"], {
      cwd: WORKER_ROOT,
      env: {
        ...process.env,
        WORKER_QUEUES: "SYSTEM",
        WORKER_APPLICATION_VERSION: applicationVersion,
        WORKER_HEARTBEAT_INTERVAL_MS: "2000",
        REDIS_SHUTDOWN_DEADLINE_MS: "2000",
        SCHEDULER_REGISTRATION_TIMEOUT_MS: "2000",
        // Suppress the child's OWN reconciliation/scheduler/outbox ticks
        // — this test wants ONLY the spawned child's crashed/stalled
        // attempt, recovered by the SEPARATE in-process healthy
        // instance, not the child recovering itself.
        BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS: "3600000",
        SCHEDULER_TICK_INTERVAL_MS: "3600000",
        OUTBOX_RELAY_INTERVAL_MS: "3600000",
        LOG_LEVEL: "info",
        ...extraEnv,
      },
    });
  }

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
        reject(new Error(`worker child did not report APPLICATION_READY within ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.on("data", onData);
    });
  }

  function collectOutput(child: ChildProcessWithoutNullStreams): { text: () => string } {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    return { text: () => buffer };
  }

  // Registers the 'exit' listener IMMEDIATELY (call this right after
  // spawn, before any other await) and returns a promise that resolves
  // whenever the child actually exits — even if that already happened
  // by the time the caller gets around to awaiting it. This two-step
  // shape (track early, await late) is required, not stylistic: the
  // crash-injection fixture (SIMULATE_PROCESS_CRASH_AFTER_PICKUP) can
  // exit the child within milliseconds of pickup — comfortably before a
  // test's own earlier `await waitForRowStatus(..., "RUNNING", ...)`
  // resolves. A `child.on("exit", ...)` listener registered only AFTER
  // that point can miss an 'exit' event that already fired — Node's
  // EventEmitter never replays past events to a listener added later —
  // which silently degrades into "never resolves, times out" instead of
  // observing the real, already-happened exit. Caught by this exact
  // symptom during this file's own implementation (see the DEFECT-1F-006
  // completion report).
  function trackExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });
  }

  async function waitForTrackedExit(
    exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
    timeoutMs: number,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null; timedOut: boolean }> {
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const winner = await Promise.race([exitPromise, timeout]);
    clearTimeout(timer);
    if (winner === "timeout") return { code: null, signal: null, timedOut: true };
    return { ...winner, timedOut: false };
  }

  /**
   * scheduleRetry (unmodified, existing production behavior — see
   * BullMqWorkerManager's own BASE_BACKOFF_MS/MAX_BACKOFF_MS) dispatches
   * a reconciliation-recovered retry with the SAME real BullMQ `delay`
   * as an ordinary automatic transient-failure retry (30s * 2^attempts —
   * 60s for attempts=1). That backoff is correct, unrelated to DEFECT-
   * 1F-006, and already covered elsewhere — waiting it out here would
   * only make this real-infrastructure test slow without proving
   * anything new. Promotes the exact delayed job so it becomes
   * immediately eligible for pickup, without touching production code or
   * timing.
   */
  async function promoteRetryJob(queue: Queue, backgroundJobId: string, attempts: number): Promise<void> {
    const job = await queue.getJob(`${backgroundJobId}#retry${attempts}`);
    if (!job) throw new Error(`expected a delayed retry job for ${backgroundJobId}#retry${attempts}, found none`);
    await job.promote();
  }

  async function waitForRowStatus(prisma: PrismaService, id: string, status: string, timeoutMs: number): Promise<BackgroundJob> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id } });
      if (row.status === status) return row;
      if (Date.now() > deadline) throw new Error(`row ${id} did not reach status ${status} within ${timeoutMs}ms (currently ${row.status})`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  const spawnedProcesses: ChildProcessWithoutNullStreams[] = [];
  const createdJobIds: string[] = [];

  afterEach(async () => {
    for (const child of spawnedProcesses.splice(0)) {
      if (!child.killed) child.kill("SIGKILL");
    }
  });

  /**
   * Removes every real BullMQ entry a test's own dispatch/retry could
   * have created (base id + every retry suffix its maxAttempts allows).
   * A missing prior version of this cleanup left orphaned entries in
   * Redis across failed/interrupted runs, which a freshly-spawned worker
   * in a LATER run would pick up FIRST — the exact root cause traced and
   * fixed for this file during its own implementation (see the DEFECT-
   * 1F-006 completion report).
   */
  async function cleanupDispatched(queue: Queue, ids: string[]): Promise<void> {
    for (const id of ids) {
      await queue.remove(id).catch(() => undefined);
      for (let n = 0; n <= 5; n++) {
        await queue.remove(`${id}#retry${n}`).catch(() => undefined);
      }
    }
  }

  it(
    "real process crash: worker dies after RUNNING transition; a separate healthy instance reconciles and completes the retry; no permanently-RUNNING row survives",
    async () => {
      const applicationVersion = `defect-1f-006-crash-${Date.now()}`;
      const child = spawnChildWorker(applicationVersion, { SIMULATE_PROCESS_CRASH_AFTER_PICKUP: "true" });
      spawnedProcesses.push(child);
      const exitPromise = trackExit(child); // registered before any await — see this function's own doc comment
      await waitForReady(child, 15_000);

      // Dispatcher connection — the test's own, independent of both the
      // child and the (not-yet-booted) in-process healthy instance.
      const dispatchConnection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
      const dispatchQueue = new Queue(SYSTEM_PING_V1_MANIFEST.queue, { connection: dispatchConnection });
      const dispatchPrisma = new PrismaService();
      await dispatchPrisma.$connect();

      try {
        const row = await dispatchPrisma.backgroundJob.create({
          data: { jobType: SYSTEM_PING_V1_MANIFEST.jobType, queueName: SYSTEM_PING_V1_MANIFEST.queue, correlationId: randomUUID() },
        });
        createdJobIds.push(row.id);
        await dispatchQueue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: "crash-me" }, { jobId: row.id });

        // Real pickup by the real child — confirms the guarded
        // QUEUED->RUNNING transition genuinely happened before the crash.
        const running = await waitForRowStatus(dispatchPrisma, row.id, "RUNNING", 10_000);
        expect(running.attempts).toBe(1);

        // The child must have actually died (process.exit(1) inside the
        // handler, immediately after the pickup this test just observed).
        const exitResult = await waitForTrackedExit(exitPromise, 10_000);
        expect(exitResult.timedOut).toBe(false);
        expect(exitResult.code).toBe(1);

        // Wait past manifest.timeout — the row is now a genuine stale
        // candidate under the real clock, no fabricated startedAt.
        await new Promise((resolve) => setTimeout(resolve, SYSTEM_PING_V1_MANIFEST.timeout + 1_000));

        // A SEPARATE, healthy worker instance — boots only now, modeling
        // "a second replica" — reconciles the stale row.
        const healthyModule: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await healthyModule.init();
        const healthyPrisma = healthyModule.get(PrismaService);
        const healthyHeartbeat = healthyModule.get(WorkerHeartbeatService);
        try {
          const reconciler = healthyModule.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
          const candidates = await reconciler.findStaleCandidates();
          expect(candidates.map((c) => c.id)).toContain(row.id);
          const staleRow = candidates.find((c) => c.id === row.id)!;
          const outcome = await reconciler.recoverCandidate(staleRow, randomUUID());
          expect(outcome).toBe("recovered");
          await promoteRetryJob(dispatchQueue, row.id, staleRow.attempts);

          // The healthy instance's own real BullMqWorkerManager (same
          // module, same real BullMQ Worker on SYSTEM) picks up the
          // dispatched retry and completes it for real.
          const completed = await waitForRowStatus(healthyPrisma, row.id, "COMPLETED", 10_000);
          expect(completed.attempts).toBe(2);
          expect(completed.errorCode).toBeNull();

          // RUNNING (attempt 1 pickup) -> QUEUED (reconciliation recovery)
          // -> RUNNING (attempt 2's own real pickup, its own history row)
          // -> COMPLETED (attempt 2 finishes for real).
          const history = await healthyPrisma.backgroundJobHistory.findMany({ where: { backgroundJobId: row.id }, orderBy: { occurredAt: "asc" } });
          expect(history.map((h) => h.toStatus)).toEqual(["RUNNING", "QUEUED", "RUNNING", "COMPLETED"]);
          expect((history[1].detail as { reason?: string } | null)?.reason).toBe("worker_crash_recovery");
        } finally {
          await healthyPrisma.workerHeartbeat.deleteMany({ where: { workerId: healthyHeartbeat.workerId } }).catch(() => undefined);
          await healthyModule.close();
        }
      } finally {
        const idsToClean = createdJobIds.splice(0, createdJobIds.length);
        await cleanupDispatched(dispatchQueue, idsToClean);
        await dispatchQueue.close().catch(() => undefined);
        dispatchConnection.disconnect();
        await dispatchPrisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: idsToClean } } }).catch(() => undefined);
        await dispatchPrisma.backgroundJob.deleteMany({ where: { id: { in: idsToClean } } }).catch(() => undefined);
        await dispatchPrisma.$disconnect();
      }
    },
    40_000,
  );

  it(
    "real event-loop stall: a still-alive but unresponsive worker's late write is fenced out after a separate healthy instance recovers and completes the retry",
    async () => {
      const applicationVersion = `defect-1f-006-stall-${Date.now()}`;
      const child = spawnChildWorker(applicationVersion);
      spawnedProcesses.push(child);
      const output = collectOutput(child);
      await waitForReady(child, 15_000);

      const dispatchConnection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
      const dispatchQueue = new Queue(SYSTEM_PING_V1_MANIFEST.queue, { connection: dispatchConnection });
      const dispatchQueueEvents = new QueueEvents(SYSTEM_PING_V1_MANIFEST.queue, { connection: dispatchConnection.duplicate() });
      await dispatchQueueEvents.waitUntilReady();
      const dispatchPrisma = new PrismaService();
      await dispatchPrisma.$connect();

      try {
        const row = await dispatchPrisma.backgroundJob.create({
          data: { jobType: SYSTEM_PING_V1_MANIFEST.jobType, queueName: SYSTEM_PING_V1_MANIFEST.queue, correlationId: randomUUID() },
        });
        createdJobIds.push(row.id);
        // stallOnAttempt: 1 — only THIS attempt genuinely blocks the
        // event loop; the retry (attempt 2), picked up by the separate
        // healthy instance below, runs and completes normally. Real,
        // synchronous busy-wait (not setTimeout) — see
        // SystemPingPayload.blockEventLoopMs's own doc comment for why a
        // real block, not an async delay, is required to prove this
        // specific case (an async delay would just trigger the EXISTING
        // in-process Promise.race timeout on its own, proving nothing
        // new about the reconciler).
        await dispatchQueue.add(SYSTEM_PING_V1_MANIFEST.jobType, { echo: "stall-me", stallOnAttempt: 1, blockEventLoopMs: 8_000 }, { jobId: row.id });

        const running = await waitForRowStatus(dispatchPrisma, row.id, "RUNNING", 10_000);
        expect(running.attempts).toBe(1);
        const startedAt = running.startedAt!.getTime();

        // Wait past manifest.timeout, measured from the row's own real
        // startedAt — the child is still genuinely alive (its event loop
        // is simply blocked; it has not exited, unlike the crash test).
        const elapsed = Date.now() - startedAt;
        const remainingUntilStale = SYSTEM_PING_V1_MANIFEST.timeout + 1_000 - elapsed;
        if (remainingUntilStale > 0) await new Promise((resolve) => setTimeout(resolve, remainingUntilStale));
        expect(child.exitCode).toBeNull(); // still alive — this is a stall, not a crash

        const healthyModule: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await healthyModule.init();
        const healthyPrisma = healthyModule.get(PrismaService);
        const healthyHeartbeat = healthyModule.get(WorkerHeartbeatService);
        try {
          const reconciler = healthyModule.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
          const candidates = await reconciler.findStaleCandidates();
          expect(candidates.map((c) => c.id)).toContain(row.id);
          const staleRow = candidates.find((c) => c.id === row.id)!;
          const outcome = await reconciler.recoverCandidate(staleRow, randomUUID());
          expect(outcome).toBe("recovered");
          await promoteRetryJob(dispatchQueue, row.id, staleRow.attempts);

          const completed = await waitForRowStatus(healthyPrisma, row.id, "COMPLETED", 10_000);
          expect(completed.attempts).toBe(2);

          // Now let the CHILD's own original, still-blocked attempt 1
          // finish its busy-wait and attempt its own (now stale) late
          // write. It started blocking at ~startedAt for 8s; wait out
          // whatever remains, plus margin.
          const remainingBlock = startedAt + 8_000 + 2_000 - Date.now();
          if (remainingBlock > 0) await new Promise((resolve) => setTimeout(resolve, remainingBlock));

          // Row must be untouched by attempt 1's late write.
          const final = await healthyPrisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
          expect(final.status).toBe("COMPLETED");
          expect(final.attempts).toBe(2);

          const history = await healthyPrisma.backgroundJobHistory.findMany({ where: { backgroundJobId: row.id }, orderBy: { occurredAt: "asc" } });
          expect(history.map((h) => h.toStatus)).toEqual(["RUNNING", "QUEUED", "RUNNING", "COMPLETED"]);

          // Direct evidence the child's own late write was recognized and
          // fenced, not merely silent. Confirmed by actually running this
          // test against real infrastructure (not assumed): attempt 1's
          // own in-process Promise.race timeout (manifest.timeout=5000ms)
          // does NOT fire at 5000ms — the event loop is still genuinely
          // blocked until blockEventLoopMs=8000ms — but once the loop
          // frees up, that already-pending timer fires immediately,
          // BEFORE the handler's own synchronous continuation is
          // observed as a return value. So attempt 1 resumes via
          // process()'s TIMEOUT/failure branch (scheduleRetryOrDeadLetter
          // -> scheduleRetry), not its success branch — exactly the path
          // this file's own runFenced doc comment (bullmq-worker.manager.ts)
          // and the retry-dead-letter.e2e-spec.ts "duplicate scheduling
          // prevention" test both established should propagate its
          // conflict rather than being silently swallowed, so
          // RECONCILER_STALE_ATTEMPT_FENCED (success-path-only) never
          // fires here. scheduleRetry's own existing conflict log is the
          // correct, actually-produced evidence instead.
          expect(output.text()).toContain("retry scheduling conflict — row was no longer RUNNING at write time");
        } finally {
          await healthyPrisma.workerHeartbeat.deleteMany({ where: { workerId: healthyHeartbeat.workerId } }).catch(() => undefined);
          await healthyModule.close();
        }
      } finally {
        const idsToClean = createdJobIds.splice(0, createdJobIds.length);
        await cleanupDispatched(dispatchQueue, idsToClean);
        await dispatchQueueEvents.close().catch(() => undefined);
        await dispatchQueue.close().catch(() => undefined);
        dispatchConnection.disconnect();
        await dispatchPrisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: idsToClean } } }).catch(() => undefined);
        await dispatchPrisma.backgroundJob.deleteMany({ where: { id: { in: idsToClean } } }).catch(() => undefined);
        await dispatchPrisma.$disconnect();
      }
    },
    45_000,
  );
});
