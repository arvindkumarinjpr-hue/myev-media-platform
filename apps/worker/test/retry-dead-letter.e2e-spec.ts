import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Queue, QueueEvents } from "bullmq";
import Redis from "ioredis";
import { SYSTEM_PING_V1_MANIFEST } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
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

  it("reports a live WorkerHeartbeat row for this process", async () => {
    const row = await prisma.workerHeartbeat.findUnique({ where: { workerId: heartbeat.workerId } });
    expect(row).not.toBeNull();
  });
});
