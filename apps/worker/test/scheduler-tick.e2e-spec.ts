import { randomUUID } from "crypto";
import { UNREACHABLE_REDIS_URL } from "@myev/shared";
import { Test, type TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { AppModule } from "../src/app.module";
import { PrismaService } from "@myev/worker-core";
import { SchedulerTickManager } from "../src/scheduler/scheduler-tick.manager";
import { BullMqWorkerManager } from "@myev/worker-core";
import { OutboxRelayManager } from "../src/events/outbox-relay.manager";
import { BackgroundJobReconciliationManager } from "@myev/worker-core";
import { WorkerHeartbeatService } from "@myev/worker-core";
import type { ScheduledJob } from "../../api/generated/prisma";

/** Shape shared by OutboxRelayManager/BackgroundJobReconciliationManager's own registration/tick resources — see cleanupBrokenSchedulerModule's own doc comment. */
interface RegistrationTickManagerInternals {
  registrationRetryTimer?: NodeJS.Timeout;
  inFlightRegistrationConnection?: { disconnect: () => void };
  tickWorker?: { close: (force?: boolean) => Promise<void> };
  tickQueue?: { close: () => Promise<void> };
  dispatchQueues?: Map<string, { close: () => Promise<void> }>;
  connection?: { disconnect: () => void };
}

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
   * provider's onApplicationShutdown as part of ONE ordered chain, and a
   * bounded race against that whole chain can give up before it ever
   * reaches a later provider's own shutdown hook at all.
   *
   * POST-MERGE WORKER E2E CLEANUP FIX (test-harness only, no production
   * change): every broken-module manager below is force-cleaned directly
   * via its own fields, rather than by invoking its onApplicationShutdown()
   * — deliberately NOT calling that method here. Proven, via a real
   * spawned-process reproduction, that calling onApplicationShutdown()
   * first (the original approach, kept for years for SchedulerTickManager
   * only) is actively counterproductive: BullMQ's own `Worker.close()`
   * caches its `closing` promise on FIRST call and silently ignores the
   * `force` argument on every subsequent call (see bullmq's own
   * classes/worker.js `close(force = false) { if (this.closing) return
   * this.closing; ... }`) — so once onApplicationShutdown()'s own
   * internal graceful (non-forced) close has started in the background,
   * a later manual `.close(true)` here is silently downgraded to that
   * same non-forced close, which can itself hang against unreachable
   * Redis. Every manager's registration-retry timer and in-flight
   * registration connection are cleared the same way
   * onApplicationShutdown() itself would (see each manager's own
   * onApplicationShutdown doc comment) — just done here directly, first,
   * so this helper — not a racing internal shutdown call — is what wins
   * ownership of each resource.
   */
  async function cleanupBrokenSchedulerModule(brokenModuleRef: TestingModule): Promise<void> {
    const brokenHeartbeat = brokenModuleRef.get(WorkerHeartbeatService);
    await prisma.workerHeartbeat.deleteMany({ where: { workerId: brokenHeartbeat.workerId } });

    for (const ManagerClass of [SchedulerTickManager, OutboxRelayManager, BackgroundJobReconciliationManager] as const) {
      const brokenManager = brokenModuleRef.get(ManagerClass) as unknown as RegistrationTickManagerInternals;
      if (brokenManager.registrationRetryTimer) clearTimeout(brokenManager.registrationRetryTimer);
      brokenManager.inFlightRegistrationConnection?.disconnect();
      brokenManager.tickWorker?.close(true).catch(() => undefined);
      brokenManager.tickQueue?.close().catch(() => undefined);
      if (brokenManager.dispatchQueues) {
        for (const queue of brokenManager.dispatchQueues.values()) queue.close().catch(() => undefined);
      }
      brokenManager.connection?.disconnect();
    }

    const brokenWorkerManager = brokenModuleRef.get(BullMqWorkerManager);
    for (const worker of (brokenWorkerManager as unknown as { workers: Array<{ close: (force?: boolean) => Promise<void> }> }).workers) {
      worker.close(true).catch(() => undefined);
    }
    (brokenWorkerManager as unknown as { connection?: { disconnect: () => void } }).connection?.disconnect();

    // Best-effort only from here — every resource above is already
    // force-neutralized directly, so this is a formality/safety net, not
    // load-bearing for correctness.
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
   *
   * Final correction (review round 2): Promise.race alone bounded the
   * CALLER's wait but did nothing to the abandoned upsertJobScheduler()
   * call itself — empirically proven (real unreachable Redis probes run
   * this session) that reusing one long-lived, forever-retrying
   * connection across every registration attempt let pending
   * promises/offline-queued commands accumulate without bound for the
   * duration of an outage. Fixed by giving every attempt its own
   * dedicated, single-use connection/Queue, explicitly disconnected the
   * moment that attempt's deadline expires — see
   * scheduler-tick.manager.ts's own `attemptRegistration()` doc comment
   * for the full empirical trail. The tests below prove the resulting
   * resource-safety properties directly against real infrastructure.
   */
  describe("DEFECT-1F-004: bounded scheduler-registration startup", () => {
    const SHORT_TIMEOUT_MS = "1000";
    const SHORT_RETRY_INTERVAL_MS = "500";

    /**
     * Redirects a broken module's SUBSEQUENT registration attempts to a
     * different redisUrl without rebuilding the module — ConfigService
     * snapshots WorkerConfig once at module init from process.env, so
     * mutating process.env mid-test has no effect on an already-compiled
     * module; this spies on the injected ConfigService's own `get`
     * instead, passing every other key straight through unchanged. Used
     * only to simulate Redis recovery mid-test (items 6-8 below) — never
     * touches any already-abandoned attempt's own connection, since each
     * one reads redisUrl once, for itself, at its own start and is fully
     * disconnected by the time its own attemptRegistration() call
     * returns.
     */
    function installRedisUrlOverride(moduleRef: TestingModule): { setUrl: (url: string) => void; restore: () => void } {
      const configService = moduleRef.get(ConfigService);
      const originalGet = configService.get.bind(configService);
      let override: string | undefined;
      const spy = jest.spyOn(configService, "get").mockImplementation((...args: unknown[]) => {
        if (args[0] === "redisUrl" && override !== undefined) {
          return override;
        }
        return (originalGet as (...a: unknown[]) => unknown)(...args);
      });
      return {
        setUrl: (url: string) => {
          override = url;
        },
        restore: () => spy.mockRestore(),
      };
    }

    it("bootstrap against unreachable Redis completes well within the configured deadline — never hangs indefinitely", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
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
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
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
        // Upper bound too, not just a lower one: with a 1000ms timeout and
        // a 500ms retry interval observed for 2500ms, sequential
        // (non-overlapping) scheduling can produce at most ~3 of each —
        // a bug that let attempts overlap/duplicate (e.g. two retry
        // chains running concurrently) would produce visibly more than
        // this. Combined with the flat active-handle-count evidence
        // below (which a genuinely overlapping pair of live registration
        // connections would also perturb), this is the test-level half
        // of "at most one live attempt at a time" — the other half is
        // structural: scheduleRegistrationRetry's setTimeout callback
        // only ever calls itself again from inside attemptRegistration()'s
        // OWN .then()/.catch(), i.e. after that attempt's promise (and
        // its finally-block cleanup) has already settled.
        expect(failedEvents.length).toBeLessThanOrEqual(4);
        expect(retryingEvents.length).toBeLessThanOrEqual(4);
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

    it("prolonged outage: active handle count stays bounded across many retry cycles — no growing pending commands, sockets, or unresolved promises", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      const originalRetryInterval = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = "400";
      process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = "200";
      let brokenModuleRef: TestingModule | undefined;
      try {
        brokenModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await brokenModuleRef.init();

        // Node's own diagnostic API (the same one DEFECT-1F-002 used to
        // prove a real handle leak rather than relying on Jest timing
        // alone) — counts every live timer/socket/etc. in this process.
        const activeHandles = () => (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length;

        const samples: number[] = [];
        // Six full timeout+retry cycles (400+200=600ms each = ~3.6s):
        // long enough that if each abandoned attempt's connection/queue
        // were leaking (a growing offline queue, an uncancelled
        // reconnect loop, a lingering socket), the handle count would
        // visibly climb across these samples.
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          samples.push(activeHandles());
        }

        const first = samples[0];
        const max = Math.max(...samples);
        const last = samples[samples.length - 1];
        // Bounded, not growing. The tolerance here is deliberately
        // looser than a single-process local run would need — a shared,
        // noisier CI runner can transiently show a handle or two more at
        // one exact sampling instant (GC timing, scheduler jitter)
        // without that being a real leak. What this test actually
        // guards against is a PER-CYCLE growth trend: a genuine leak
        // (one abandoned connection surviving per cycle) would add
        // roughly 1 handle per cycle, so across 6 cycles it would push
        // well past this tolerance — a one-off +2/+3 blip at a single
        // sample would not.
        expect(max).toBeLessThanOrEqual(first + 4);
        expect(last).toBeLessThanOrEqual(first + 4);
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = originalRetryInterval;
        if (brokenModuleRef) {
          await cleanupBrokenSchedulerModule(brokenModuleRef);
        }
      }
    }, 20_000);

    it("Redis recovery after a prolonged outage creates exactly one scheduler registration — no burst of previously-abandoned upserts firing at once", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      const originalRetryInterval = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS;
      const healthyRedisUrl = originalRedisUrl as string;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = "400";
      process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = "300";
      let brokenModuleRef: TestingModule | undefined;
      let override: ReturnType<typeof installRedisUrlOverride> | undefined;
      try {
        brokenModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await brokenModuleRef.init();

        const brokenManager = brokenModuleRef.get(SchedulerTickManager);
        const infoSpy = jest.spyOn((brokenManager as unknown as { logger: { info: (...args: unknown[]) => void } }).logger, "info");

        // Let it fail through a couple of full cycles against the
        // unreachable address first — the actual "prolonged outage" this
        // defect's resource-safety claims are about. Each abandoned
        // attempt's own connection is permanently disconnected by the
        // time attemptRegistration() returns (proven in the handle-count
        // test above), so none of them can ever fire again on their own.
        await new Promise((resolve) => setTimeout(resolve, 1_400));

        // Redirect only the NEXT scheduled attempt to the real, healthy
        // Redis — does not touch any already-abandoned attempt.
        override = installRedisUrlOverride(brokenModuleRef);
        override.setUrl(healthyRedisUrl);

        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const recoveredEvents = infoSpy.mock.calls.filter((call) => (call[0] as { event?: string })?.event === "SCHEDULER_REGISTRATION_RECOVERED");
        // Exactly one recovery — not a burst of N redundant successes
        // from previously-abandoned attempts all firing at once (they
        // structurally can't: each one's connection was already torn
        // down and its reconnect loop permanently halted).
        expect(recoveredEvents.length).toBe(1);

        // Independent, fresh introspection connection against the real
        // Redis (never the broken manager's own tickQueue/connection,
        // which is fixed to the broken address for this manager's whole
        // lifetime, matching the explicit requirement that the tick
        // Worker is never disconnected merely because registration
        // timed out).
        const verifyConnection = new Redis(healthyRedisUrl, { maxRetriesPerRequest: null });
        const verifyQueue = new Queue("SCHEDULER_INTERNAL", { connection: verifyConnection });
        try {
          const schedulers = await verifyQueue.getJobSchedulers(0, -1);
          const matching = schedulers.filter((s) => s.key === "scheduler-tick-primary");
          expect(matching).toHaveLength(1);
        } finally {
          await verifyQueue.close().catch(() => undefined);
          verifyConnection.disconnect();
        }
      } finally {
        override?.restore();
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = originalRetryInterval;
        if (brokenModuleRef) {
          await cleanupBrokenSchedulerModule(brokenModuleRef);
        }
      }
    }, 15_000);

    it("two SchedulerTickManager instances recovering concurrently still converge to exactly one scheduler registration", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      const originalRetryInterval = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS;
      const healthyRedisUrl = originalRedisUrl as string;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = "400";
      process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = "300";
      let firstModuleRef: TestingModule | undefined;
      let secondModuleRef: TestingModule | undefined;
      let firstOverride: ReturnType<typeof installRedisUrlOverride> | undefined;
      let secondOverride: ReturnType<typeof installRedisUrlOverride> | undefined;
      try {
        [firstModuleRef, secondModuleRef] = await Promise.all([
          Test.createTestingModule({ imports: [AppModule] }).compile(),
          Test.createTestingModule({ imports: [AppModule] }).compile(),
        ]);
        await Promise.all([firstModuleRef.init(), secondModuleRef.init()]);

        // Both replicas fail against the unreachable address for a bit...
        await new Promise((resolve) => setTimeout(resolve, 1_100));

        // ...then both recover concurrently.
        firstOverride = installRedisUrlOverride(firstModuleRef);
        secondOverride = installRedisUrlOverride(secondModuleRef);
        firstOverride.setUrl(healthyRedisUrl);
        secondOverride.setUrl(healthyRedisUrl);

        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const verifyConnection = new Redis(healthyRedisUrl, { maxRetriesPerRequest: null });
        const verifyQueue = new Queue("SCHEDULER_INTERNAL", { connection: verifyConnection });
        try {
          const schedulers = await verifyQueue.getJobSchedulers(0, -1);
          const matching = schedulers.filter((s) => s.key === "scheduler-tick-primary");
          expect(matching).toHaveLength(1);
        } finally {
          await verifyQueue.close().catch(() => undefined);
          verifyConnection.disconnect();
        }
      } finally {
        firstOverride?.restore();
        secondOverride?.restore();
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = originalRetryInterval;
        for (const ref of [firstModuleRef, secondModuleRef]) {
          if (ref) await cleanupBrokenSchedulerModule(ref);
        }
      }
    }, 15_000);

    it("POST-MERGE WORKER E2E CLEANUP FIX — cross-file contamination regression: two broken-Redis module instances (all four managers) are fully neutralized by cleanup, and a fresh AppModule boot immediately afterward, in the same process, sees zero interference", async () => {
      // The real CI failure this proves against was cross-file
      // contamination within one Jest worker process (maxWorkers: 1) —
      // this test reproduces that exact shape in miniature, entirely
      // within a single test, rather than relying on file-execution
      // order across separate spec files.
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      const originalRetryInterval = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = "400";
      process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = "300";

      let firstModuleRef: TestingModule | undefined;
      let secondModuleRef: TestingModule | undefined;
      let freshModuleRef: TestingModule | undefined;
      const errorSpies: Array<ReturnType<typeof jest.spyOn>> = [];

      try {
        [firstModuleRef, secondModuleRef] = await Promise.all([
          Test.createTestingModule({ imports: [AppModule] }).compile(),
          Test.createTestingModule({ imports: [AppModule] }).compile(),
        ]);
        await Promise.all([firstModuleRef.init(), secondModuleRef.init()]);

        // Spy on every manager's own error logger across BOTH broken
        // instances — this is what a leaked, still-retrying connection
        // would keep calling long after cleanup, per the real CI evidence
        // ("BullMQ worker error" / "scheduler tick worker error" /
        // OutboxRelayManager's/BackgroundJobReconciliationManager's own
        // equivalents, continuing for 100+ seconds post-cleanup).
        for (const moduleRef of [firstModuleRef, secondModuleRef]) {
          for (const ManagerClass of [SchedulerTickManager, BullMqWorkerManager, OutboxRelayManager, BackgroundJobReconciliationManager] as const) {
            const manager = moduleRef.get(ManagerClass) as unknown as { logger: { error: (...args: unknown[]) => void } };
            errorSpies.push(jest.spyOn(manager.logger, "error"));
          }
        }

        // Let both replicas actually fail against the unreachable address
        // for a bit — the genuine "outage" scenario, not a fabricated one.
        await new Promise((resolve) => setTimeout(resolve, 1_200));

        const errorCountBeforeCleanup = errorSpies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
        expect(errorCountBeforeCleanup).toBeGreaterThan(0); // sanity: the outage was real

        process.env.REDIS_URL = originalRedisUrl;
        await Promise.all([cleanupBrokenSchedulerModule(firstModuleRef), cleanupBrokenSchedulerModule(secondModuleRef)]);
        const errorCountAtCleanup = errorSpies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);

        // A forced .disconnect()/.close(true) cannot synchronously cancel
        // an OS-level DNS lookup or TCP connect already in flight at the
        // exact moment it's called — each of the 8 primary connections
        // (4 managers x 2 instances) can therefore fire, at most, ONE
        // more trailing error shortly afterward as that specific in-
        // flight attempt finally settles. That is real, unavoidable I/O
        // latency, not a leak — the actual defect this regression proves
        // against is an ONGOING RETRY LOOP, so the assertion below checks
        // for renewed growth in a LATER window, after any such one-time
        // tail has had time to land, rather than demanding zero calls in
        // the instant cleanup returns (which no real forced-disconnect
        // can structurally guarantee).
        await new Promise((resolve) => setTimeout(resolve, 800));
        const errorCountAfterTail = errorSpies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
        expect(errorCountAfterTail - errorCountAtCleanup).toBeLessThanOrEqual(8);

        // Wait well past several more would-be retry/registration cycles
        // (SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS=300 above — this is
        // ~13 such cycles). If anything were still alive and genuinely
        // retrying, this window — not the tail window above — is where
        // it would show up as renewed growth.
        await new Promise((resolve) => setTimeout(resolve, 4_000));

        const errorCountAfterWait = errorSpies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
        // Zero NEW error-logger calls from ANY of the eight loggers once
        // the one-time tail has settled — the defining proof that
        // nothing is still alive and retrying.
        expect(errorCountAfterWait).toBe(errorCountAfterTail);

        // Now boot a completely fresh, healthy AppModule instance in this
        // SAME process — standing in for "the next spec file" in the real
        // CI failure. It must initialize cleanly, with no interference
        // (no unexpected errors, no unexplained delay) from the two
        // instances just torn down above.
        const freshStart = Date.now();
        freshModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await freshModuleRef.init();
        const freshBootMs = Date.now() - freshStart;
        expect(freshBootMs).toBeLessThan(5_000);

        const freshManager = freshModuleRef.get(SchedulerTickManager);
        const freshErrorSpy = jest.spyOn((freshManager as unknown as { logger: { error: (...args: unknown[]) => void } }).logger, "error");
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(freshErrorSpy.mock.calls.length).toBe(0);
      } finally {
        for (const spy of errorSpies) spy.mockRestore();
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = originalRetryInterval;
        for (const ref of [firstModuleRef, secondModuleRef]) {
          if (ref) await cleanupBrokenSchedulerModule(ref);
        }
        if (freshModuleRef) await freshModuleRef.close();
      }
    }, 20_000);

    it("shutdown cancels the retry timer — no further registration attempts, and the process's active handle count does not keep climbing afterward", async () => {
      const originalRedisUrl = process.env.REDIS_URL;
      const originalTimeout = process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS;
      const originalRetryInterval = process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS;
      process.env.REDIS_URL = UNREACHABLE_REDIS_URL;
      process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = "300";
      process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = "200";
      let brokenModuleRef: TestingModule | undefined;
      try {
        brokenModuleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
        await brokenModuleRef.init();

        const brokenManager = brokenModuleRef.get(SchedulerTickManager);
        const warnSpy = jest.spyOn((brokenManager as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger, "warn");

        // Let at least one full cycle happen first.
        await new Promise((resolve) => setTimeout(resolve, 600));

        const activeHandles = () => (process as unknown as { _getActiveHandles: () => unknown[] })._getActiveHandles().length;
        const beforeShutdown = activeHandles();

        await cleanupBrokenSchedulerModule(brokenModuleRef);
        brokenModuleRef = undefined; // already cleaned up — don't clean up twice in `finally`

        const retryingCountAtShutdown = warnSpy.mock.calls.filter((call) => (call[0] as { event?: string })?.event === "SCHEDULER_REGISTRATION_RETRYING").length;

        // Wait well past several more would-be retry cycles.
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const retryingCountAfterWait = warnSpy.mock.calls.filter((call) => (call[0] as { event?: string })?.event === "SCHEDULER_REGISTRATION_RETRYING").length;
        // No new retries were scheduled after shutdown — the timer was
        // genuinely cancelled, not just outlived by the test.
        expect(retryingCountAfterWait).toBe(retryingCountAtShutdown);

        const afterWait = activeHandles();
        // The process's own handle count settles rather than continuing
        // to grow once shutdown has run — same tolerance and reasoning
        // as the prolonged-outage test above (a shared CI runner can
        // show a sample-instant blip that isn't a real trend).
        expect(afterWait).toBeLessThanOrEqual(beforeShutdown + 4);
      } finally {
        process.env.REDIS_URL = originalRedisUrl;
        process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS = originalTimeout;
        process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS = originalRetryInterval;
        if (brokenModuleRef) {
          await cleanupBrokenSchedulerModule(brokenModuleRef);
        }
      }
    }, 15_000);
  });
});
