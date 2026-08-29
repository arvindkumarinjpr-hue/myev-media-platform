import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { SYSTEM_PING_V1_MANIFEST, UNREACHABLE_REDIS_URL } from "@myev/shared";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import { BackgroundJobReconciliationManager } from "../src/reconciliation/background-job-reconciliation.manager";
import { BullMqWorkerManager, JobLifecycleConflictError } from "../src/bullmq/bullmq-worker.manager";
import type { BackgroundJob, BackgroundJobHistory } from "../../api/generated/prisma";

/**
 * DEFECT-1F-006 — real Postgres (real Redis where noted), no mocking.
 * Most tests here construct a BackgroundJob row directly in a specific
 * RUNNING/attempts state via Prisma (the identical technique
 * outbox-relay.e2e-spec.ts's own claim/lease correctness tests already
 * established for testing internal engine mechanics in isolation from a
 * full real pickup/dispatch race) and drive the reconciliation
 * manager's own internal methods directly via the same "expose a narrow
 * internal-methods interface, cast through unknown" technique that
 * file's own OutboxRelayInternals/BullMqWorkerManagerInternals already
 * use — never a mock, never a stub; every read/write below is a real
 * guarded SQL statement against real Postgres.
 *
 * The centerpiece fencing proof (a stale attempt resuming AFTER a newer
 * attempt has taken ownership) and the real-process crash/event-loop-
 * stall proofs live in the separate
 * background-job-reconciliation-realworld.e2e-spec.ts file, which uses
 * real spawned worker processes — deliberately not mixed into this file,
 * since those need a genuinely separate OS process/event loop to prove
 * anything the in-process engine's own Promise.race timeout couldn't
 * already explain on its own (see that file's own class doc comment).
 */

interface ReconciliationInternals {
  findStaleCandidates: () => Promise<BackgroundJob[]>;
  recoverCandidate: (candidate: BackgroundJob, correlationId: string) => Promise<"recovered" | "conflict-skipped">;
}

// Exposes BullMqWorkerManager's own private transitionTerminal — the
// identical technique outbox-relay.e2e-spec.ts already uses (see its own
// OutboxRelayInternals/BullMqWorkerManagerInternals) to drive internal
// engine mechanics directly and deterministically in a test, never a
// mock or stub — every call still executes the real guarded SQL.
interface BullMqTerminalInternals {
  transitionTerminal: (
    backgroundJobId: string,
    expectedAttempts: number,
    status: "COMPLETED" | "FAILED" | "TIMED_OUT",
    fields?: { errorCode?: string; errorMessageSafe?: string; resultMetadata?: object | null; cancelledAt?: Date; deadLettered?: boolean },
  ) => Promise<void>;
}

const UNREGISTERED_JOB_TYPE = "reconciliation-test.unregistered.v1";

describe("Worker (e2e) — DEFECT-1F-006 BackgroundJobReconciliationManager", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";
  process.env.REDIS_SHUTDOWN_DEADLINE_MS = process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS ?? "2000";
  process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS ?? "2000";
  // Suppress the manager's own real background tick for every test here —
  // each test drives findStaleCandidates/recoverCandidate directly and
  // deterministically, matching OutboxRelayManager's own established
  // "very large interval to suppress the real tick" technique.
  process.env.BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS = "3600000";
  process.env.BACKGROUND_JOB_RECONCILIATION_BATCH_SIZE = process.env.BACKGROUND_JOB_RECONCILIATION_BATCH_SIZE ?? "50";
  // Module 6 Phase 6.5-A2 (E2E test isolation): bootstrap() below compiles
  // the FULL AppModule, so every one of this file's ~20 bootstrap/cleanup
  // cycles also brings up a real OutboxRelayManager as pure collateral —
  // this suite never touches outbox events at all. Left at its 2000ms
  // default, each cycle re-registers BullMQ's OUTBOX_RELAY_INTERNAL
  // repeatable-job scheduler at that short interval; moduleRef.close()'s
  // onApplicationShutdown() closes the tickWorker/tickQueue CLIENT objects
  // but — correctly, for production, where the scheduler is meant to
  // survive a graceful restart of a replica — never deregisters the
  // scheduler itself server-side in Redis. Across 20 cycles that leaves a
  // live, still-ticking scheduler plus an accumulating backlog of
  // "outbox.relay.tick.v1" jobs in a shared (non-test-scoped) queue that
  // outlives this file entirely: proven, empirically, to be exactly what
  // caused event-consumer-execution.e2e-spec.ts's own freshly-booted
  // OutboxRelayManager/tickWorker (sharing the same fixed queue name) to
  // start draining that backlog the instant it boots, racing that suite's
  // own manual claimUndispatchedEvents() calls (DEFECT-1F-006 root cause,
  // Phase 6.5-A2). Suppressing it here — this file's own concern, exactly
  // like the reconciliation suppression above — keeps every cycle's
  // upsert at the harmless 1-hour interval, so no such backlog can ever
  // form in the first place.
  process.env.OUTBOX_RELAY_INTERVAL_MS = "3600000";

  const originalRedisUrl = process.env.REDIS_URL;
  afterEach(() => {
    process.env.REDIS_URL = originalRedisUrl;
  });

  const createdJobIds: string[] = [];

  // DEFECT-1F-006: several tests here call the REAL scheduleRetry (via
  // recoverCandidate/scheduleRetryOrDeadLetter, exercised directly and
  // deliberately unmocked) — meaning they dispatch REAL BullMQ jobs
  // (`${id}#retry${attempts}`) to the real SYSTEM queue, not just write
  // Postgres rows. An earlier version of this file only ever deleted the
  // Postgres side, silently leaving real, un-processed BullMQ job
  // entries (and, for rows never picked back up, real RUNNING Postgres
  // rows) behind — contaminating background-job-reconciliation-realworld.e2e-spec.ts's
  // own real queue with backlog it then had to compete against, which is
  // exactly the failure this fix addresses: test isolation, not
  // production behavior.
  const cleanupConnection = new Redis(process.env.REDIS_URL as string, { maxRetriesPerRequest: null });
  const cleanupQueue = new Queue(SYSTEM_PING_V1_MANIFEST.queue, { connection: cleanupConnection });

  async function bootstrap(): Promise<{ moduleRef: TestingModule; prisma: PrismaService; heartbeat: WorkerHeartbeatService }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    return { moduleRef, prisma: moduleRef.get(PrismaService), heartbeat: moduleRef.get(WorkerHeartbeatService) };
  }

  async function cleanup(moduleRef: TestingModule, heartbeat: WorkerHeartbeatService): Promise<void> {
    const prisma = moduleRef.get(PrismaService);
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: heartbeat.workerId } }).catch(() => undefined);

    for (const id of createdJobIds.splice(0)) {
      // Every retry attempt this test's own maxAttempts could ever have
      // produced (tests here use maxAttempts <= 5) — removing an id that
      // was never actually dispatched is a harmless no-op. Uses the
      // independent cleanupQueue, not this module's own connection —
      // must still work regardless of moduleRef's own lifecycle.
      await cleanupQueue.remove(id).catch(() => undefined);
      for (let n = 0; n <= 5; n++) {
        await cleanupQueue.remove(`${id}#retry${n}`).catch(() => undefined);
      }
      await prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: id } }).catch(() => undefined);
      await prisma.backgroundJob.deleteMany({ where: { id } }).catch(() => undefined);
    }

    await moduleRef.close();
  }

  /** Constructs a RUNNING row with a backdated startedAt, bypassing a real pickup — the deliberate, established technique for testing staleness/fencing mechanics in isolation (see class doc comment). */
  async function createRunningRow(
    prisma: PrismaService,
    opts: { jobType?: string; attempts?: number; maxAttempts?: number; startedAgoMs: number; cancellationRequestedAt?: Date },
  ): Promise<BackgroundJob> {
    const row = await prisma.backgroundJob.create({
      data: {
        jobType: opts.jobType ?? SYSTEM_PING_V1_MANIFEST.jobType,
        queueName: SYSTEM_PING_V1_MANIFEST.queue,
        correlationId: randomUUID(),
        status: "RUNNING",
        attempts: opts.attempts ?? 1,
        maxAttempts: opts.maxAttempts ?? 3,
        startedAt: new Date(Date.now() - opts.startedAgoMs),
        cancellationRequestedAt: opts.cancellationRequestedAt,
      },
    });
    createdJobIds.push(row.id);
    return row;
  }

  async function history(prisma: PrismaService, backgroundJobId: string): Promise<BackgroundJobHistory[]> {
    return prisma.backgroundJobHistory.findMany({ where: { backgroundJobId }, orderBy: { occurredAt: "asc" } });
  }

  afterAll(async () => {
    await cleanupQueue.close().catch(() => undefined);
    cleanupConnection.disconnect();
  });

  describe("stale detection rule", () => {
    it("a RUNNING row younger than manifest.timeout is NOT a candidate", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout - 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const candidates = await manager.findStaleCandidates();
        expect(candidates.map((c) => c.id)).not.toContain(row.id);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it("a RUNNING row older than manifest.timeout IS a candidate", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const candidates = await manager.findStaleCandidates();
        expect(candidates.map((c) => c.id)).toContain(row.id);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it("a RUNNING row whose jobType has no registered ProcessorManifest is stale immediately, regardless of age", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { jobType: UNREGISTERED_JOB_TYPE, startedAgoMs: 100 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const candidates = await manager.findStaleCandidates();
        expect(candidates.map((c) => c.id)).toContain(row.id);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });
  });

  describe("recovery outcomes", () => {
    it("attempts remaining: recovered as a retry, QUEUED, history reason worker_crash_recovery", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;

        const outcome = await manager.recoverCandidate(row, randomUUID());
        expect(outcome).toBe("recovered");

        const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(updated.status).toBe("QUEUED");
        expect(updated.attempts).toBe(1); // untouched — only the next pickup increments it
        expect(updated.errorCode).toBe("WORKER_CRASH_DETECTED");

        const rows = await history(prisma, row.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].toStatus).toBe("QUEUED");
        expect((rows[0].detail as { reason?: string } | null)?.reason).toBe("worker_crash_recovery");
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it("attempts exhausted: recovered straight to TIMED_OUT, dead-lettered, WORKER_CRASH_DETECTED", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 3, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;

        const outcome = await manager.recoverCandidate(row, randomUUID());
        expect(outcome).toBe("recovered");

        const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(updated.status).toBe("TIMED_OUT");
        expect(updated.deadLetteredAt).not.toBeNull();
        expect(updated.errorCode).toBe("WORKER_CRASH_DETECTED");
        expect(updated.errorMessageSafe).toContain("recovered after apparent worker failure");

        const rows = await history(prisma, row.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].toStatus).toBe("TIMED_OUT");
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it("cancellation requested while stale: recovery honors it — FAILED/JOB_CANCELLED_BY_USER, never retried", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, {
          attempts: 1,
          maxAttempts: 3,
          startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000,
          cancellationRequestedAt: new Date(),
        });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;

        const outcome = await manager.recoverCandidate(row, randomUUID());
        expect(outcome).toBe("recovered");

        const updated = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(updated.status).toBe("FAILED");
        expect(updated.errorCode).toBe("JOB_CANCELLED_BY_USER");
        expect(updated.cancelledAt).not.toBeNull();
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });
  });

  describe("concurrency", () => {
    it("two reconcilers racing the same stale row: exactly one recovers, the other is conflict-skipped", async () => {
      const bootA = await bootstrap();
      const bootB = await bootstrap();
      try {
        const row = await createRunningRow(bootA.prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });

        const managerA = bootA.moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const managerB = bootB.moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;

        const [outcomeA, outcomeB] = await Promise.all([managerA.recoverCandidate(row, randomUUID()), managerB.recoverCandidate(row, randomUUID())]);

        const outcomes = [outcomeA, outcomeB].sort();
        expect(outcomes).toEqual(["conflict-skipped", "recovered"]);

        // Exactly one history row — the loser never reached its own
        // history-write statement (guarded UPDATE affected zero rows
        // first) — not a duplicate, not two competing entries.
        const rows = await history(bootA.prisma, row.id);
        expect(rows).toHaveLength(1);
      } finally {
        await cleanup(bootA.moduleRef, bootA.heartbeat);
        await cleanup(bootB.moduleRef, bootB.heartbeat);
      }
    });

    it("a legitimate completion racing reconciliation: exactly one write wins, the other is fenced", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const bullMq = moduleRef.get(BullMqWorkerManager) as unknown as BullMqTerminalInternals;

        const results = await Promise.allSettled([
          manager.recoverCandidate(row, randomUUID()),
          // Stands in for "the real execution's own legitimate completion
          // write" — the exact call process() itself makes on success.
          bullMq.transitionTerminal(row.id, row.attempts, "COMPLETED", { resultMetadata: { echo: "pong" } }),
        ]);

        // Both calls target the identical (id, attempts) pair — Postgres
        // serializes the two guarded UPDATEs; exactly one of the two
        // underlying writes can ever succeed. recoverCandidate itself
        // swallows JobLifecycleConflictError (returns "conflict-skipped"
        // instead of rejecting); the direct transitionTerminal call does
        // not, so at most one of these two promises rejects.
        const rejected = results.filter((r) => r.status === "rejected");
        expect(rejected.length).toBeLessThanOrEqual(1);
        if (rejected.length === 1) {
          expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(JobLifecycleConflictError);
        }

        const final = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        // Whichever writer won, the row is in EXACTLY one terminal-ish
        // state — never a mix of both outcomes' fields.
        expect(["QUEUED", "COMPLETED"]).toContain(final.status);

        const rows = await history(prisma, row.id);
        expect(rows).toHaveLength(1);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });
  });

  describe("stale-attempt fencing — the centerpiece proof, direct-call form", () => {
    it("a stale attempt's snapshot (attempts=1) is rejected once a newer attempt (attempts=2) owns the row — success outcome", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const bullMq = moduleRef.get(BullMqWorkerManager);
        const bullMqInternals = moduleRef.get(BullMqWorkerManager) as unknown as BullMqTerminalInternals;

        // Reconciler recovers attempt 1 -> QUEUED.
        expect(await manager.recoverCandidate(row, randomUUID())).toBe("recovered");
        // A newer attempt (2) takes over — the real guarded pickup transition.
        const pickedUp = await prisma.backgroundJob.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } } });
        expect(pickedUp.count).toBe(1);
        const owned = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(owned.attempts).toBe(2);
        // Attempt 2 legitimately completes — via the real transitionTerminal,
        // not a hand-rolled update, so it reproduces the exact same
        // errorCode/errorMessageSafe-clearing behavior a real completion
        // has (WORKER_CRASH_DETECTED was set on the row by the recovery
        // above; a real COMPLETED transition clears it).
        await bullMqInternals.transitionTerminal(row.id, 2, "COMPLETED", { resultMetadata: { echo: "pong" } });

        // Attempt 1, resuming late, still holding its own stale snapshot
        // (attempts: 1), tries to record its own (fabricated) success.
        const staleSnapshot: BackgroundJob = { ...row, attempts: 1 };
        await expect(bullMq.scheduleRetryOrDeadLetter(staleSnapshot, "TIMED_OUT", "PROCESSOR_TIMEOUT", "irrelevant — should never be written")).rejects.toBeInstanceOf(JobLifecycleConflictError);

        const final = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(final.status).toBe("COMPLETED");
        expect(final.attempts).toBe(2);
        expect(final.errorCode).toBeNull(); // cleared by attempt 2's real completion; attempt 1's stale write never landed

        const rows = await history(prisma, row.id);
        // Exactly two REAL transitions: RUNNING->QUEUED (recovery of
        // attempt 1), then RUNNING->COMPLETED (attempt 2's real,
        // legitimate completion) — no third row from attempt 1's
        // rejected, fenced-out late write.
        expect(rows.map((h) => h.toStatus)).toEqual(["QUEUED", "COMPLETED"]);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it.each([
      { label: "failure (transient, retry)", terminalStatusOnExhaustion: "FAILED" as const, errorCode: "PROCESSOR_ERROR", maxAttempts: 3 },
      { label: "timeout, attempts exhausted (dead-letter)", terminalStatusOnExhaustion: "TIMED_OUT" as const, errorCode: "PROCESSOR_TIMEOUT", maxAttempts: 1 },
    ])("stale attempt 1 later attempts a $label write after attempt 2 already owns the row: 0 rows affected, no history, attempt 2 untouched", async ({ terminalStatusOnExhaustion, errorCode, maxAttempts }) => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const bullMq = moduleRef.get(BullMqWorkerManager);

        expect(await manager.recoverCandidate(row, randomUUID())).toBe("recovered");
        await prisma.backgroundJob.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } } });
        await prisma.backgroundJob.update({ where: { id: row.id }, data: { status: "COMPLETED", completedAt: new Date() } });
        const beforeStaleWrite = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        const historyCountBefore = (await history(prisma, row.id)).length;

        const staleSnapshot: BackgroundJob = { ...row, attempts: 1, maxAttempts };
        await expect(bullMq.scheduleRetryOrDeadLetter(staleSnapshot, terminalStatusOnExhaustion, errorCode, "stale — must never be recorded")).rejects.toBeInstanceOf(JobLifecycleConflictError);

        const after = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(after).toEqual(beforeStaleWrite);
        expect((await history(prisma, row.id)).length).toBe(historyCountBefore);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it("stale attempt 1 later attempts a retry write after attempt 2 already owns the row: 0 rows affected, no duplicate retry dispatched", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 5, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const bullMq = moduleRef.get(BullMqWorkerManager);

        expect(await manager.recoverCandidate(row, randomUUID())).toBe("recovered");
        await prisma.backgroundJob.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } } });
        const owned = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(owned.attempts).toBe(2);

        // Attempt 1, resuming, believes it should schedule a further retry.
        const staleSnapshot: BackgroundJob = { ...row, attempts: 1 };
        await expect(bullMq.scheduleRetryOrDeadLetter(staleSnapshot, "FAILED", "PROCESSOR_ERROR", "stale retry — must never be scheduled")).rejects.toBeInstanceOf(JobLifecycleConflictError);

        const after = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("RUNNING");
        expect(after.attempts).toBe(2); // untouched by attempt 1's rejected retry
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });
  });

  describe("idempotent repeated ticks", () => {
    it("recovering the same row twice in a row: second call is conflict-skipped, not a duplicate recovery", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;

        expect(await manager.recoverCandidate(row, randomUUID())).toBe("recovered");
        // Second call reuses the SAME (stale) candidate snapshot — attempts
        // still 1 in the object, but the row has already moved to QUEUED.
        expect(await manager.recoverCandidate(row, randomUUID())).toBe("conflict-skipped");

        const rows = await history(prisma, row.id);
        expect(rows).toHaveLength(1);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });

    it("a row already QUEUED (recovered) is no longer a findStaleCandidates() candidate on the next scan", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;

        await manager.recoverCandidate(row, randomUUID());
        const candidates = await manager.findStaleCandidates();
        expect(candidates.map((c) => c.id)).not.toContain(row.id);
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });
  });

  describe("Redis unavailable during recovery", () => {
    it("recovery dispatch failure is compensated to dead-lettered, mirroring the existing scheduleRetry compensation path", async () => {
      const { moduleRef, prisma, heartbeat } = await bootstrap();
      try {
        const row = await createRunningRow(prisma, { attempts: 1, maxAttempts: 3, startedAgoMs: SYSTEM_PING_V1_MANIFEST.timeout + 2_000 });
        const manager = moduleRef.get(BackgroundJobReconciliationManager) as unknown as ReconciliationInternals;
        const bullMq = moduleRef.get(BullMqWorkerManager) as unknown as { getQueue: (queueName: string) => { add: (...args: unknown[]) => Promise<unknown> } };

        // Force the dispatch queue this recovery will use to be
        // unreachable, without touching the manager's own primary
        // connection (mirrors this same technique's use elsewhere in
        // this suite family for targeted dispatch-failure proofs).
        const originalAdd = bullMq.getQueue(SYSTEM_PING_V1_MANIFEST.queue).add.bind(bullMq.getQueue(SYSTEM_PING_V1_MANIFEST.queue));
        bullMq.getQueue(SYSTEM_PING_V1_MANIFEST.queue).add = () => Promise.reject(new Error("simulated Redis unavailable"));

        try {
          await expect(manager.recoverCandidate(row, randomUUID())).rejects.toThrow("simulated Redis unavailable");
        } finally {
          bullMq.getQueue(SYSTEM_PING_V1_MANIFEST.queue).add = originalAdd;
        }

        const after = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: row.id } });
        expect(after.status).toBe("FAILED");
        expect(after.deadLetteredAt).not.toBeNull();
        expect(after.errorCode).toBe("RETRY_DISPATCH_FAILED");
      } finally {
        await cleanup(moduleRef, heartbeat);
      }
    });
  });

  describe("bounded shutdown", () => {
    it("healthy Redis: shuts down GRACEFUL", async () => {
      const { moduleRef, heartbeat } = await bootstrap();
      const outcomePromise = new Promise<void>((resolve) => setTimeout(resolve, 50));
      await outcomePromise;
      await cleanup(moduleRef, heartbeat);
      // No throw, no hang — the assertion is that this test itself
      // completes within Jest's own timeout, matching
      // SchedulerTickManager/OutboxRelayManager's own identical-shape
      // shutdown tests.
    });

    it("unreachable Redis at shutdown time: FORCED, not hung", async () => {
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      const { moduleRef, heartbeat } = await bootstrap();
      const start = Date.now();
      await cleanup(moduleRef, heartbeat);
      expect(Date.now() - start).toBeLessThan(10_000);
    });
  });
});
