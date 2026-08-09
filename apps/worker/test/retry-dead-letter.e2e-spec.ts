import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { SYSTEM_PING_V1_MANIFEST } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { BullMqWorkerManager } from "../src/bullmq/bullmq-worker.manager";
import { SchedulerTickManager } from "../src/scheduler/scheduler-tick.manager";
import type { BackgroundJob, BackgroundJobHistory } from "../../api/generated/prisma";

/**
 * Module 1F Milestone 5: retry/backoff/dead-letter, and the "exactly one
 * component is responsible for scheduling a retry" invariant. Runs
 * against real Postgres + Redis + the real BullMqWorkerManager — no
 * mocking. Uses BullMQ's own Job.promote() to fast-forward past the real
 * (30s-to-10min) backoff delay rather than waiting it out in the suite;
 * scheduling correctness itself (the row transition, the job_history
 * detail, the delayed BullMQ entry's configured delay) is asserted
 * directly instead.
 */
describe("Worker (e2e) — retry, backoff, and dead-letter", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let heartbeat: WorkerHeartbeatService;
  let queue: Queue;
  let queueEvents: QueueEvents;
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    heartbeat = moduleRef.get(WorkerHeartbeatService);

    const connection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
    queue = new Queue(SYSTEM_PING_V1_MANIFEST.queue, { connection });
    queueEvents = new QueueEvents(SYSTEM_PING_V1_MANIFEST.queue, { connection: connection.duplicate() });
    await queueEvents.waitUntilReady();
  });

  afterAll(async () => {
    await prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: createdJobIds } } });
    await prisma.backgroundJob.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } });
    await queueEvents.close();
    await queue.close();
    await moduleRef.close();
  });

  // payloadMetadata must be set to the SAME payload the test then passes
  // to queue.add() — in production, BackgroundJobsService.enqueue()
  // always writes this before ever dispatching, and the Worker's own
  // automatic retry re-dispatches by reading it BACK from Postgres (not
  // from the concluded BullMQ delivery's job.data). A row created without
  // it would make a real retry re-dispatch with the wrong payload.
  async function createRow(overrides: Partial<{ attempts: number; maxAttempts: number; payload: object }> = {}): Promise<BackgroundJob> {
    const row = await prisma.backgroundJob.create({
      data: {
        jobType: SYSTEM_PING_V1_MANIFEST.jobType,
        queueName: SYSTEM_PING_V1_MANIFEST.queue,
        correlationId: randomUUID(),
        attempts: overrides.attempts ?? 0,
        maxAttempts: overrides.maxAttempts ?? 3,
        payloadMetadata: overrides.payload ?? {},
      },
    });
    createdJobIds.push(row.id);
    return row;
  }

  async function historyFor(jobId: string): Promise<BackgroundJobHistory[]> {
    return prisma.backgroundJobHistory.findMany({ where: { backgroundJobId: jobId }, orderBy: { occurredAt: "asc" } });
  }

  describe("timeout vs retry", () => {
    it("a timed-out attempt with attempts remaining is scheduled for automatic retry (QUEUED, not terminal), with the correct backoff", async () => {
      const payload = { delayMs: 6_000 };
      // manifest.timeout is 5000ms — delayMs well beyond it guarantees a
      // ProcessorTimeoutError on this attempt.
      const row = await createRow({ maxAttempts: 3, payload });
      const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, payload, { jobId: row.id });

      // waitUntilFinished settles the instant THIS delivery's processor
      // promise does (success or failure) — no polling-interval race with
      // a transition that could otherwise be faster than any poll cadence.
      // This attempt is expected to fail (timeout), so the rejection here
      // is the expected outcome, not a test failure.
      await job.waitUntilFinished(queueEvents, 8_000).catch(() => undefined);
      const afterFirstAttempt = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });

      expect(afterFirstAttempt.status).toBe("QUEUED");
      expect(afterFirstAttempt.attempts).toBe(1);
      expect(afterFirstAttempt.errorCode).toBe("PROCESSOR_TIMEOUT");
      expect(afterFirstAttempt.deadLetteredAt).toBeNull();

      const history = await historyFor(row.id);
      expect(history.map((h) => h.toStatus)).toEqual(["RUNNING", "QUEUED"]);
      const retryEntry = history[1];
      expect(retryEntry.detail).toMatchObject({ reason: "automatic_retry", attempt: 1, maxAttempts: 3, nextAttemptDelayMs: 60_000 });

      // The scheduled retry dispatches under a distinct, suffixed BullMQ
      // id (see BullMqWorkerManager.scheduleRetry's own comment for why
      // it can't safely reuse the just-concluded delivery's id) —
      // process() strips the suffix back off to recover the real
      // background_jobs.id when this retry is eventually picked up.
      const bullJob = await queue.getJob(`${row.id}#retry1`);
      expect(bullJob).toBeDefined();
      expect(await bullJob?.getState()).toBe("delayed");
      expect(bullJob?.opts.delay).toBe(60_000);

      // Don't let the real 60s backoff actually fire during this suite.
      await bullJob?.remove();
    }, 15_000);
  });

  describe("scheduled retry actually re-executes", () => {
    it("promotes past the backoff delay and completes successfully on the retried attempt", async () => {
      const payload = { echo: "recovers", failUntilAttempt: 2 };
      const row = await createRow({ maxAttempts: 3, payload });
      const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, payload, { jobId: row.id });

      await job.waitUntilFinished(queueEvents, 5_000).catch(() => undefined);
      const afterFirstAttempt = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
      expect(afterFirstAttempt.status).toBe("QUEUED");
      expect(afterFirstAttempt.attempts).toBe(1);
      expect(afterFirstAttempt.errorCode).toBe("PROCESSOR_ERROR");

      const bullJob = await queue.getJob(`${row.id}#retry1`);
      expect(await bullJob?.getState()).toBe("delayed");
      await bullJob?.promote();

      const result = await bullJob?.waitUntilFinished(queueEvents, 10_000);
      expect((result as { echo?: string })?.echo).toBe("recovers");

      const final = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
      expect(final.status).toBe("COMPLETED");
      expect(final.attempts).toBe(2);
      expect(final.errorCode).toBeNull();

      const history = await historyFor(row.id);
      expect(history.map((h) => h.toStatus)).toEqual(["RUNNING", "QUEUED", "RUNNING", "COMPLETED"]);
    }, 15_000);
  });

  describe("dead-letter transition after retry exhaustion", () => {
    it("a permanently-failing job is dead-lettered once attempts are exhausted, and is never retried again", async () => {
      // Pre-seeded one attempt short of the ceiling — pickup increments
      // to exactly maxAttempts, so this single execution is the
      // exhausting one, no need to wait through multiple real cycles.
      const payload = { failUntilAttempt: 10 };
      const row = await createRow({ attempts: 2, maxAttempts: 3, payload });
      const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, payload, { jobId: row.id });

      await job.waitUntilFinished(queueEvents, 5_000).catch(() => undefined);
      const final = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });

      expect(final.status).toBe("FAILED");
      expect(final.attempts).toBe(3);
      expect(final.errorCode).toBe("PROCESSOR_ERROR");
      expect(final.deadLetteredAt).not.toBeNull();

      const history = await historyFor(row.id);
      expect(history.map((h) => h.toStatus)).toEqual(["RUNNING", "FAILED"]);
      expect(history[1].detail).toMatchObject({ errorCode: "PROCESSOR_ERROR", deadLettered: true });

      // No further automatic retry was scheduled: the just-finished
      // BullMQ entry is in its own failed state, not delayed.
      const bullJob = await queue.getJob(row.id);
      expect(await bullJob?.getState()).toBe("failed");
    }, 10_000);

    it("cancellation, once requested, is authoritative even for a generic (non-JobCancelledError) failure with attempts remaining", async () => {
      const payload = { delayMs: 400, failUntilAttempt: 10 };
      const row = await createRow({ maxAttempts: 3, payload });
      const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, payload, { jobId: row.id });

      // Request cancellation directly (not via the processor's own
      // isCancelled() checkpoint) while the job is still RUNNING, mid-delay.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await prisma.backgroundJob.update({ where: { id: row.id }, data: { cancellationRequestedAt: new Date() } });

      await job.waitUntilFinished(queueEvents, 5_000).catch(() => undefined);
      const final = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });

      // The processor itself never observed the cancellation (its own
      // isCancelled() checks happen before/after the delay, and
      // failUntilAttempt throws a generic Error regardless) — but the
      // engine's own retry-decision chokepoint still redirects to the
      // CANCELLED terminal mapping instead of scheduling a retry.
      expect(final.status).toBe("FAILED");
      expect(final.errorCode).toBe("JOB_CANCELLED_BY_USER");
      expect(final.cancelledAt).not.toBeNull();
      expect(final.deadLetteredAt).toBeNull();
    }, 10_000);
  });

  describe("duplicate scheduling prevention", () => {
    it("rejects a terminal/retry transition deterministically when the row is no longer RUNNING at write time, instead of overwriting a conflicting outcome", async () => {
      const payload = { delayMs: 500, failUntilAttempt: 10 };
      const row = await createRow({ maxAttempts: 3, payload });
      await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, payload, { jobId: row.id });

      // Wait until the Worker has picked the job up (RUNNING) but before
      // its own failure/retry-scheduling logic runs (which happens after
      // the 500ms artificial delay) — then simulate "something else
      // already concluded this execution" by writing a conflicting
      // terminal state directly, exactly as a second scheduler would.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const midFlight = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
      expect(midFlight.status).toBe("RUNNING");

      const conflictingDeadLetterTime = new Date();
      await prisma.backgroundJob.update({
        where: { id: row.id },
        data: { status: "FAILED", failedAt: conflictingDeadLetterTime, deadLetteredAt: conflictingDeadLetterTime, errorCode: "SIMULATED_CONFLICTING_WRITER" },
      });

      const bullJob = await queue.getJob(row.id);
      const rejection = await bullJob?.waitUntilFinished(queueEvents, 10_000).catch((error: Error) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(/job lifecycle conflict/);

      // The Worker's own attempted write must have been rejected outright
      // — the row still reflects exactly what the "other writer" set,
      // not a mix of both, and not the Worker's own PROCESSOR_ERROR outcome.
      const after = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("FAILED");
      expect(after.errorCode).toBe("SIMULATED_CONFLICTING_WRITER");
      expect(after.deadLetteredAt?.getTime()).toBe(conflictingDeadLetterTime.getTime());

      // And no second job_history row was appended by the Worker's
      // rejected attempt — only the original QUEUED->RUNNING transition
      // exists.
      const history = await historyFor(row.id);
      expect(history.map((h) => h.toStatus)).toEqual(["RUNNING"]);
    }, 10_000);
  });

  describe("crash-recovery: a stray delivery against an already-terminal row", () => {
    it("is safely skipped — never re-executed, and the row is left completely untouched", async () => {
      // Simulates BullMQ redelivering a job whose row has already reached
      // a terminal, dead-lettered state — e.g. via BullMQ's own native
      // stalled-job recovery finding a stale entry after a worker crash
      // that happened AFTER this process's own dead-letter transition had
      // already committed, but before it could inform BullMQ. The pickup
      // guard (status must be QUEUED) must reject this exactly the same
      // way it rejects any other duplicate delivery.
      const row = await createRow({ maxAttempts: 3 });
      const deadLetteredAt = new Date();
      await prisma.backgroundJob.update({
        where: { id: row.id },
        data: { status: "FAILED", failedAt: deadLetteredAt, deadLetteredAt, errorCode: "PROCESSOR_ERROR", errorMessageSafe: "Job execution failed." },
      });

      const job = await queue.add(SYSTEM_PING_V1_MANIFEST.jobType, {}, { jobId: row.id });
      const result = await job.waitUntilFinished(queueEvents, 5_000);
      expect(result).toEqual({ skipped: true });

      const after = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).toBe("FAILED");
      expect(after.errorCode).toBe("PROCESSOR_ERROR");
      expect(after.deadLetteredAt?.getTime()).toBe(deadLetteredAt.getTime());
      expect(after.attempts).toBe(0);

      // No history row at all — the guard rejected the delivery before
      // ever writing anything.
      const history = await historyFor(row.id);
      expect(history).toHaveLength(0);
    }, 10_000);
  });

  describe("Redis connection resilience", () => {
    it("a Redis connection error does not crash the worker process (ioredis's own reconnect is allowed to recover instead)", async () => {
      // Without an explicit .on('error', ...) listener on the raw ioredis
      // client, Node's EventEmitter throws (crashing the whole process)
      // the moment ANY 'error' event fires with zero listeners attached —
      // exactly what an unreachable Redis endpoint produces immediately.
      // This boots a second, fully isolated application instance pointed
      // at a real host with nothing listening on that port (fast,
      // deterministic ECONNREFUSED — not a DNS timeout) and asserts the
      // process survives long enough to be cleanly torn down, proving the
      // fix rather than asserting on log output.
      const originalRedisUrl = process.env.REDIS_URL;
      process.env.REDIS_URL = "redis://redis:1";
      let brokenModuleRef: TestingModule | undefined;
      try {
        brokenModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await expect(brokenModuleRef.init()).resolves.toBeDefined();
        // Give the doomed connection attempt(s) time to actually fail and
        // emit 'error' — this is the moment an unhandled listener would
        // have brought the process down.
        await new Promise((resolve) => setTimeout(resolve, 500));
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        if (brokenModuleRef) {
          // This instance's own WorkerHeartbeatService still wrote a row
          // (Postgres was never the broken dependency here) — clean it up
          // rather than leaving an orphaned heartbeat behind.
          const brokenHeartbeat = brokenModuleRef.get(WorkerHeartbeatService);
          await prisma.workerHeartbeat.deleteMany({ where: { workerId: brokenHeartbeat.workerId } });
          // A genuine, separate finding from writing this test (noted in
          // the Milestone 5 review, deliberately NOT fixed in production
          // code here — it's an onApplicationShutdown/graceful-shutdown
          // concern from Milestone 3, not a retry/dead-letter one):
          // BullMqWorkerManager's own shutdown (worker.close() and
          // connection.quit()) both wait for a graceful Redis handshake
          // that a truly unreachable connection will never provide, so a
          // full close() here can hang indefinitely. Bounded so THIS test
          // doesn't hang.
          //
          // Losing that race does NOT mean the connections are harmlessly
          // abandoned: ioredis's default retryStrategy keeps retrying
          // ECONNREFUSED forever, so unclosed connections here keep the
          // event loop alive and the whole Jest process hangs on exit
          // (found while validating Milestone 6 — a real leak, distinct
          // from DEFECT-1F-001 itself, which is about production shutdown
          // behavior, not this test's own cleanup).
          //
          // Two separate connections need forcing, not one: BullMQ's Worker
          // internally duplicates its own "blocking connection" for
          // BRPOPLPUSH-style commands, which it owns and normally closes
          // gracefully in worker.close() — but only skips the graceful
          // handshake when called with force=true, which
          // onApplicationShutdown() does not do. The manager's raw shared
          // `connection` is explicitly NOT owned/closed by BullMQ (a
          // user-supplied connection), so it needs its own explicit
          // fallback regardless.
          //
          // Order matters here. Losing the race below leaves
          // onApplicationShutdown()'s own internal close chain running
          // detached in the background (the race abandons the *wait*, not
          // the underlying call) — and if the raw connection is still
          // reconnecting when that detached chain reaches
          // `connection.quit()`, ioredis queues QUIT as an offline command
          // that will never flush, hanging that detached promise forever
          // too (a silent leak with no further log output, distinct from
          // the earlier one). So: force-close every Worker AND disconnect
          // the raw connection FIRST, before ever attempting the graceful
          // module close — that way both the redundant worker.close() and
          // connection.quit() calls inside onApplicationShutdown() find
          // everything already in the 'end' state and resolve immediately
          // instead of blocking on a handshake that will never arrive.
          const brokenManager = brokenModuleRef.get(BullMqWorkerManager);
          const brokenInternals = brokenManager as unknown as {
            workers?: { close: (force?: boolean) => Promise<void> }[];
            connection?: { disconnect: () => void };
          };
          await Promise.all((brokenInternals.workers ?? []).map((worker) => worker.close(true)));
          brokenInternals.connection?.disconnect();

          // Module 1F Milestone 7 added SchedulerTickManager to this same
          // AppModule (this test predates it, Milestone 5) — its own
          // onApplicationBootstrap() also opens a connection against
          // whatever REDIS_URL was set above, and its onApplicationShutdown()
          // shares the identical DEFECT-1F-001 characteristic just
          // documented for BullMqWorkerManager: awaiting tickWorker.close()
          // against an unreachable connection never resolves. Proven via a
          // direct instrumented run (FINAL SHUTDOWN OWNERSHIP REPORT): the
          // shutdown hook chain reaches SchedulerTickManager fine and even
          // cancels its background registration-retry timer, but then hangs
          // indefinitely on this exact await, leaving `connection` (and the
          // tickWorker/tickQueue built on it) never disconnected — the
          // observed leak (continuing "Redis connection error" /
          // "scheduler tick worker error" logs, and Jest's own "Cannot log
          // after tests are done" warning bleeding into whichever later
          // test happens to be running when the abandoned connection's own
          // reconnect attempts fire). Mirrors the BullMqWorkerManager
          // handling immediately above for exactly the same reason.
          const brokenScheduler = brokenModuleRef.get(SchedulerTickManager);
          const brokenSchedulerInternals = brokenScheduler as unknown as {
            tickWorker?: { close: (force?: boolean) => Promise<void> };
            connection?: { disconnect: () => void };
          };
          await brokenSchedulerInternals.tickWorker?.close(true);
          brokenSchedulerInternals.connection?.disconnect();

          await Promise.race([brokenModuleRef.close(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
        }
      }
    }, 15_000);
  });

  it("reports a live WorkerHeartbeat row for this process", async () => {
    const row = await prisma.workerHeartbeat.findUnique({ where: { workerId: heartbeat.workerId } });
    expect(row).not.toBeNull();
  });
});
