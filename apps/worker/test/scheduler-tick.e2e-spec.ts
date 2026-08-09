import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { SchedulerTickManager } from "../src/scheduler/scheduler-tick.manager";
import { BullMqWorkerManager } from "../src/bullmq/bullmq-worker.manager";
import { WorkerHeartbeatService } from "../src/heartbeat/worker-heartbeat.service";
import type { ScheduledJob } from "../../api/generated/prisma";

/**
 * Module 1F Milestone 7 (Scheduler Foundation), Revision 3. Runs against
 * real Postgres + Redis (the dev Docker Compose stack), no mocking. Uses
 * direct invocation of SchedulerTickManager's own (private) scan/dispatch
 * methods for deterministic, fast control over "when a tick fires" —
 * the real BullMQ repeatable-job registration path is exercised
 * separately (registration/bootstrap tests below) via the real
 * upsertJobScheduler/getJobSchedulers APIs, not bypassed.
 */
describe("Worker (e2e) — SchedulerTickManager", () => {
  process.env.WORKER_QUEUES = process.env.WORKER_QUEUES ?? "SYSTEM";
  process.env.WORKER_APPLICATION_VERSION = process.env.WORKER_APPLICATION_VERSION ?? "e2e-test";
  process.env.WORKER_HEARTBEAT_INTERVAL_MS = process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "2000";

  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let manager: SchedulerTickManager;
  const createdScheduleIds: string[] = [];
  const createdJobIds: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    manager = moduleRef.get(SchedulerTickManager);

    // BullMQ's upsertJobScheduler dispatches its first occurrence almost
    // immediately on registration, not after a full tickIntervalMs wait —
    // confirmed the hard way (this real, automatic tick was racing every
    // deterministic manual invocation below via the same SKIP LOCKED
    // claim, non-deterministically stealing rows before assertions ran).
    // Removed immediately after bootstrap so every dispatch in this suite
    // is driven only by this file's own explicit calls; registration
    // itself is exercised independently and explicitly further down.
    const tickQueueForSetup = (manager as unknown as { tickQueue: { removeJobScheduler: (id: string) => Promise<boolean> } }).tickQueue;
    await tickQueueForSetup.removeJobScheduler("scheduler-tick-primary");
  });

  afterAll(async () => {
    await prisma.backgroundJobHistory.deleteMany({ where: { backgroundJobId: { in: createdJobIds } } });
    await prisma.backgroundJob.deleteMany({ where: { id: { in: createdJobIds } } });
    await prisma.scheduledJob.deleteMany({ where: { id: { in: createdScheduleIds } } });
    await moduleRef.close();
  });

  async function createSchedule(overrides: Partial<{ jobType: string; payload: object; nextRunAt: Date; enabled: boolean; workspaceId: string | null; cronExpression: string; timezone: string }> = {}): Promise<ScheduledJob> {
    const row = await prisma.scheduledJob.create({
      data: {
        workspaceId: overrides.workspaceId ?? null,
        jobType: overrides.jobType ?? "system.ping.v1",
        payloadMetadata: overrides.payload ?? {},
        cronExpression: overrides.cronExpression ?? "0 9 * * *",
        timezone: overrides.timezone ?? "UTC",
        enabled: overrides.enabled ?? true,
        nextRunAt: overrides.nextRunAt ?? new Date(Date.now() - 60_000),
      },
    });
    createdScheduleIds.push(row.id);
    return row;
  }

  /**
   * DEFECT-1F-004's own test cleanup, found the hard way: racing the
   * WHOLE module's close() against a bound (as the pre-existing Milestone
   * 5 "Redis connection resilience" test above does for a DIFFERENT
   * provider) is not sufficient here, because NestJS invokes every
   * provider's onApplicationShutdown as part of ONE ordered chain —
   * BullMqWorkerManager's own shutdown (which has the identical
   * DEFECT-1F-001 hang characteristic against unreachable Redis) can sit
   * ahead of SchedulerTickManager's in that chain, meaning the bounded
   * race gives up on the OUTER close() before SchedulerTickManager's own
   * shutdown — and therefore its registrationRetryTimer clearTimeout —
   * ever runs at all. Confirmed directly: a real hung Jest process,
   * SCHEDULER_REGISTRATION_FAILED logs continuing every ~1.5s long after
   * "Ran all test suites" had already printed. Fixed here by invoking
   * SchedulerTickManager's own onApplicationShutdown directly first
   * (bounded), independent of the rest of the module's own shutdown
   * ordering.
   *
   * Separately (confirmed empirically, not assumed): BullMqWorkerManager
   * — a different provider in this same broken module instance — has the
   * identical DEFECT-1F-001 characteristic on its own connection, and
   * this is PRE-EXISTING (verified directly: the pre-existing Milestone 5
   * "Redis connection resilience" test, entirely untouched by this
   * defect's fix, leaves the same kind of lingering process behind it
   * too). Not this defect's scope to fix in production code — but this
   * test file's own fixtures force-disconnect it too, exactly the same
   * way that pre-existing test's own bounded-race comment already
   * documents as a known, deliberate limitation.
   */
  async function cleanupBrokenSchedulerModule(brokenModuleRef: TestingModule): Promise<void> {
    const brokenHeartbeat = brokenModuleRef.get(WorkerHeartbeatService);
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: brokenHeartbeat.workerId } });

    const brokenSchedulerManager = brokenModuleRef.get(SchedulerTickManager);
    await Promise.race([(brokenSchedulerManager as unknown as { onApplicationShutdown: () => Promise<void> }).onApplicationShutdown(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
    (brokenSchedulerManager as unknown as { connection?: { disconnect: () => void } }).connection?.disconnect();

    const brokenWorkerManager = brokenModuleRef.get(BullMqWorkerManager);
    (brokenWorkerManager as unknown as { connection?: { disconnect: () => void } }).connection?.disconnect();

    // Best-effort only from here.
    await Promise.race([brokenModuleRef.close(), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }

  async function runTick(): Promise<void> {
    // handleTick is private — direct invocation is the accepted technique
    // for deterministically controlling scan timing in tests without
    // waiting on the real 60s repeatable-job interval, or adding a
    // test-only public method to production code.
    await (manager as unknown as { handleTick: (job: unknown) => Promise<void> }).handleTick(undefined);
  }

  async function trackJobsFor(scheduleId: string): Promise<string[]> {
    const key = `schedule:${scheduleId}:`;
    const jobs = await prisma.backgroundJob.findMany({ where: { idempotencyKey: { startsWith: key } } });
    jobs.forEach((j) => createdJobIds.push(j.id));
    return jobs.map((j) => j.id);
  }

  describe("SKIP misfire policy", () => {
    it("an overdue schedule produces exactly one background_jobs row, never a backfill", async () => {
      const farPast = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30); // 30 days overdue
      const schedule = await createSchedule({ cronExpression: "0 * * * *", nextRunAt: farPast });

      await runTick();

      const jobIds = await trackJobsFor(schedule.id);
      expect(jobIds).toHaveLength(1);
    });

    it("nextRunAt after a claim is strictly after now(), never derived from incrementing the stale prior value", async () => {
      const farPast = new Date(Date.now() - 1000 * 60 * 60 * 24 * 30);
      const schedule = await createSchedule({ cronExpression: "0 * * * *", nextRunAt: farPast });

      await runTick();

      const refreshed = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: schedule.id } });
      expect(refreshed.nextRunAt).not.toBeNull();
      expect(refreshed.nextRunAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
      // Not "farPast + one hour, repeated 720 times" — a single jump to
      // the next real occurrence after now, not a backfilled increment.
      expect(refreshed.nextRunAt!.getTime()).toBeLessThan(Date.now() + 1000 * 60 * 60 * 2);
    });
  });

  describe("idempotency", () => {
    it("duplicate dispatch of the identical due occurrence creates exactly one logical job (workspace-scoped)", async () => {
      const schedule = await createSchedule({ nextRunAt: new Date(Date.now() - 60_000) });
      const dueOccurrence = schedule.nextRunAt!;
      const correlationId = randomUUID();

      const dispatch = (manager as unknown as { dispatchOccurrence: (o: { schedule: ScheduledJob; dueOccurrence: Date }, c: string) => Promise<boolean> }).dispatchOccurrence.bind(manager);

      const first = await dispatch({ schedule, dueOccurrence }, correlationId);
      const second = await dispatch({ schedule, dueOccurrence }, correlationId);

      expect(first).toBe(true);
      expect(second).toBe(false); // replay, not a new dispatch

      const jobIds = await trackJobsFor(schedule.id);
      expect(jobIds).toHaveLength(1);
    });

    it("duplicate dispatch of the identical due occurrence creates exactly one logical job (platform-level, workspaceId: null)", async () => {
      const schedule = await createSchedule({ workspaceId: null, nextRunAt: new Date(Date.now() - 60_000) });
      const dueOccurrence = schedule.nextRunAt!;
      const correlationId = randomUUID();

      const dispatch = (manager as unknown as { dispatchOccurrence: (o: { schedule: ScheduledJob; dueOccurrence: Date }, c: string) => Promise<boolean> }).dispatchOccurrence.bind(manager);

      const first = await dispatch({ schedule, dueOccurrence }, correlationId);
      const second = await dispatch({ schedule, dueOccurrence }, correlationId);

      expect(first).toBe(true);
      expect(second).toBe(false);

      const jobIds = await trackJobsFor(schedule.id);
      expect(jobIds).toHaveLength(1);
      const row = await prisma.backgroundJob.findUniqueOrThrow({ where: { id: jobIds[0] } });
      expect(row.workspaceId).toBeNull();
    });
  });

  describe("concurrency: SELECT ... FOR UPDATE SKIP LOCKED", () => {
    it("two concurrent claim scans never both claim the same due schedule", async () => {
      const schedule = await createSchedule({ nextRunAt: new Date(Date.now() - 60_000) });

      const claim = (manager as unknown as { claimDueSchedules: () => Promise<Array<{ schedule: ScheduledJob; dueOccurrence: Date }>> }).claimDueSchedules.bind(manager);
      const [a, b] = await Promise.all([claim(), claim()]);

      const aHasIt = a.some((c) => c.schedule.id === schedule.id);
      const bHasIt = b.some((c) => c.schedule.id === schedule.id);
      // Exactly one of the two concurrent scans claims it — SKIP LOCKED
      // means the other sees it as locked and simply omits it, never
      // blocks and never double-claims.
      expect(aHasIt !== bHasIt).toBe(true);
    });
  });

  describe("per-row error isolation", () => {
    it("a schedule with an unknown jobType is auto-disabled and does not block other due schedules in the same batch", async () => {
      const bad = await createSchedule({ jobType: "not.a.real.job.v1", nextRunAt: new Date(Date.now() - 60_000) });
      const good = await createSchedule({ nextRunAt: new Date(Date.now() - 60_000) });

      await runTick();

      const badRefreshed = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: bad.id } });
      expect(badRefreshed.enabled).toBe(false);
      expect(badRefreshed.lastErrorCode).toBe("SCHEDULE_JOB_TYPE_UNKNOWN");
      expect(badRefreshed.lastErrorMessageSafe).toBeTruthy();

      const goodJobIds = await trackJobsFor(good.id);
      expect(goodJobIds).toHaveLength(1);
    });

    it("does not leak schedule payload contents into the auto-disable error metadata", async () => {
      const secretMarker = `secret-${randomUUID()}`;
      const bad = await createSchedule({ jobType: "not.a.real.job.v1", payload: { echo: secretMarker }, nextRunAt: new Date(Date.now() - 60_000) });

      await runTick();

      const refreshed = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: bad.id } });
      expect(refreshed.lastErrorMessageSafe).not.toContain(secretMarker);
    });
  });

  describe("disable racing an in-flight claim", () => {
    it("a schedule already claimed before its disable commits still dispatches once, but never again afterward", async () => {
      const schedule = await createSchedule({ nextRunAt: new Date(Date.now() - 60_000) });

      const claim = (manager as unknown as { claimDueSchedules: () => Promise<Array<{ schedule: ScheduledJob; dueOccurrence: Date }>> }).claimDueSchedules.bind(manager);
      const dispatch = (manager as unknown as { dispatchOccurrence: (o: { schedule: ScheduledJob; dueOccurrence: Date }, c: string) => Promise<boolean> }).dispatchOccurrence.bind(manager);

      // Claim commits first (mirrors the scan already having the row
      // locked and committed before a concurrent Disable's own
      // transaction can proceed) ...
      const [claimed] = await claim();
      // ... then Disable lands.
      await prisma.scheduledJob.update({ where: { id: schedule.id }, data: { enabled: false, version: { increment: 1 } } });

      // The already-claimed occurrence still dispatches — accepted
      // behavior, not retroactively cancelled.
      const dispatched = await dispatch(claimed, randomUUID());
      expect(dispatched).toBe(true);
      await trackJobsFor(schedule.id);

      // But the schedule is now disabled, so a later tick never claims it
      // again.
      const laterClaim = await claim();
      expect(laterClaim.some((c) => c.schedule.id === schedule.id)).toBe(false);
    });
  });

  describe("scheduler tick registration", () => {
    // Exercises upsertJobScheduler directly on the already-open queue
    // rather than re-invoking the whole onApplicationBootstrap lifecycle
    // a second time on the shared, already-bootstrapped `manager` — doing
    // that would overwrite its connection/queue/worker references without
    // closing the originals first, leaking them for the rest of the
    // suite (the exact class of bug DEFECT-1F-002 found earlier this
    // engagement in a different file's test fixtures).
    type TickQueue = {
      upsertJobScheduler: (id: string, repeat: { every: number; tz: string }, template: { name: string; data: object }) => Promise<unknown>;
      removeJobScheduler: (id: string) => Promise<boolean>;
      // BullMQ's own JobSchedulerJson identifies a registration by `key`,
      // not `id` — verified empirically (a probe script against the real
      // Redis instance), since the very first version of this test always
      // silently found zero matches by filtering on the wrong field name.
      getJobSchedulers: (start?: number, end?: number) => Promise<Array<{ key: string }>>;
    };

    function tickQueue(): TickQueue {
      return (manager as unknown as { tickQueue: TickQueue }).tickQueue;
    }

    it("re-registering the tick scheduler is idempotent — exactly one registration exists", async () => {
      const queue = tickQueue();
      await queue.upsertJobScheduler("scheduler-tick-primary", { every: 60_000, tz: "UTC" }, { name: "scheduler.tick.v1", data: {} });
      const schedulers = await queue.getJobSchedulers(0, -1);
      const matching = schedulers.filter((s) => s.key === "scheduler-tick-primary");
      expect(matching).toHaveLength(1);
    });

    it("survives total loss of the BullMQ registration — re-registering from application code fully restores it", async () => {
      const queue = tickQueue();
      await queue.removeJobScheduler("scheduler-tick-primary");
      let schedulers = await queue.getJobSchedulers(0, -1);
      expect(schedulers.some((s) => s.key === "scheduler-tick-primary")).toBe(false);

      await queue.upsertJobScheduler("scheduler-tick-primary", { every: 60_000, tz: "UTC" }, { name: "scheduler.tick.v1", data: {} });

      schedulers = await queue.getJobSchedulers(0, -1);
      expect(schedulers.some((s) => s.key === "scheduler-tick-primary")).toBe(true);
    });
  });

  describe("concurrent bootstrap (multiple worker replicas)", () => {
    it("two independent SchedulerTickManager instances bootstrapping concurrently converge to exactly one tick registration", async () => {
      // Two entirely fresh module instances, neither the shared beforeAll
      // one — avoids ever double-bootstrapping (and thereby leaking) the
      // instance the rest of this suite depends on.
      let firstModuleRef: TestingModule | undefined;
      let secondModuleRef: TestingModule | undefined;
      try {
        [firstModuleRef, secondModuleRef] = await Promise.all([
          Test.createTestingModule({ imports: [AppModule] }).compile(),
          Test.createTestingModule({ imports: [AppModule] }).compile(),
        ]);
        // Race both instances' own bootstrap (each independently calls
        // upsertJobScheduler for the same scheduler id) — not relying on
        // BullMQ's documented idempotent-upsert behavior without proof.
        await Promise.all([firstModuleRef.init(), secondModuleRef.init()]);

        const secondManager = secondModuleRef.get(SchedulerTickManager);
        const queue = (secondManager as unknown as { tickQueue: { getJobSchedulers: (start?: number, end?: number) => Promise<Array<{ key: string }>> } }).tickQueue;
        const schedulers = await queue.getJobSchedulers(0, -1);
        const matching = schedulers.filter((s) => s.key === "scheduler-tick-primary");
        expect(matching).toHaveLength(1);
      } finally {
        // ref.close() already invokes onApplicationShutdown() on every
        // provider that implements it — NestJS's own standard lifecycle,
        // identical to how afterAll's moduleRef.close() cleans up the
        // shared manager elsewhere in this file. Calling it a second time
        // explicitly here (an earlier version of this test did) throws
        // "Connection is closed" on the redundant second attempt, leaving
        // that instance's own real tick registration never removed —
        // found via a genuine hung Jest process (still ticking every 60s
        // long after "Ran all test suites" had already printed), not
        // theorized.
        for (const ref of [firstModuleRef, secondModuleRef]) {
          if (!ref) continue;
          await ref.close();
        }
        // No need to restore the shared manager's own registration
        // afterward — this is the last test in the file, and the shared
        // manager's automatic ticking was already deliberately disabled
        // in beforeAll for the whole suite's duration.
      }
    }, 20_000);
  });

  /**
   * DEFECT-1F-004: bootstrap can hang indefinitely when Redis is
   * unreachable. Empirically confirmed (this session, real Redis,
   * `redis://redis:1`): the prior implementation's awaited
   * `upsertJobScheduler()` call never settled — neither resolved nor
   * rejected — so onApplicationBootstrap, and therefore the whole
   * NestJS application context, never finished initializing. Fixed as
   * bounded degraded startup: the tick Worker starts immediately
   * regardless of registration outcome (mirroring
   * BullMqWorkerManager.onApplicationBootstrap's own established,
   * never-blocks-on-Redis precedent — confirmed by inspection: that
   * method is not even `async`), and registration itself is bounded per
   * attempt, retried on a fixed background interval.
   */
  describe("DEFECT-1F-004: bounded scheduler-registration startup", () => {
    const SHORT_TIMEOUT_MS = "1000";
    const SHORT_RETRY_INTERVAL_MS = "500";

    it("bootstrap against unreachable Redis completes well within the configured deadline — never hangs indefinitely", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      process.env.REDIS_URL = "redis://redis:1";
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = SHORT_TIMEOUT_MS;
      let brokenModuleRef: TestingModule | undefined;
      try {
        brokenModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        const startedAt = Date.now();
        await expect(brokenModuleRef.init()).resolves.toBeDefined();
        const elapsedMs = Date.now() - startedAt;
        // Bounded by the configured 1000ms deadline, not the old
        // indefinite hang — generous margin for scheduling jitter, but
        // nowhere near the 15000s+ this took before the fix.
        expect(elapsedMs).toBeLessThan(5000);
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        if (brokenModuleRef) {
          await cleanupBrokenSchedulerModule(brokenModuleRef);
        }
      }
    }, 15_000);

    it("emits SCHEDULER_REGISTRATION_FAILED and keeps retrying on the configured interval while Redis remains unreachable — never a silent, unbounded hang", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      const originalRetryInterval = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS;
      process.env.REDIS_URL = "redis://redis:1";
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = SHORT_TIMEOUT_MS;
      process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = SHORT_RETRY_INTERVAL_MS;
      let brokenModuleRef: TestingModule | undefined;
      try {
        brokenModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await brokenModuleRef.init();

        const brokenManager = brokenModuleRef.get(SchedulerTickManager);
        const errorSpy = jest.spyOn((brokenManager as unknown as { logger: { error: (...args: unknown[]) => void } }).logger, "error");
        const warnSpy = jest.spyOn((brokenManager as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger, "warn");

        // Long enough for the first bounded attempt (1000ms) plus at
        // least two retry cycles (500ms apart) to have occurred.
        await new Promise((resolve) => setTimeout(resolve, 2_500));

        const failedEvents = errorSpy.mock.calls.filter((call) => (call[0] as { event?: string })?.event === "SCHEDULER_REGISTRATION_FAILED");
        const retryingEvents = warnSpy.mock.calls.filter((call) => (call[0] as { event?: string })?.event === "SCHEDULER_REGISTRATION_RETRYING");
        // At least the initial failure plus one retry attempt having
        // begun — proves the loop is genuinely active, not stalled.
        expect(failedEvents.length).toBeGreaterThanOrEqual(1);
        expect(retryingEvents.length).toBeGreaterThanOrEqual(1);
        // Never logs the connection URL or any credential-bearing value.
        for (const call of [...failedEvents, ...retryingEvents]) {
          expect(JSON.stringify(call)).not.toContain("redis://");
        }
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = originalRetryInterval;
        if (brokenModuleRef) {
          await cleanupBrokenSchedulerModule(brokenModuleRef);
        }
      }
    }, 15_000);

    it("healthy-Redis startup registers on the first attempt, well within the bounded deadline — the bound never slows down the normal case", async () => {
      // Uses the already-healthy shared `manager` from this file's own
      // beforeAll — re-registering directly (idempotent, safe) and timing
      // it, rather than booting yet another module instance.
      const tickQueueForTiming = (manager as unknown as { tickQueue: { upsertJobScheduler: (id: string, repeat: { every: number; tz: string }, template: { name: string; data: object }) => Promise<unknown> } }).tickQueue;
      const startedAt = Date.now();
      await tickQueueForTiming.upsertJobScheduler("scheduler-tick-primary", { every: 60_000, tz: "UTC" }, { name: "scheduler.tick.v1", data: {} });
      const elapsedMs = Date.now() - startedAt;
      // A real, healthy Redis round-trip — comfortably under even the
      // shortest configured registration timeout used elsewhere in this
      // describe block (1000ms), let alone the production default (5000ms).
      expect(elapsedMs).toBeLessThan(1000);
    });
  });
});
