import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { AppModule } from "../src/app.module";
import { PrismaService } from "../src/prisma/prisma.service";
import { SchedulerTickManager } from "../src/scheduler/scheduler-tick.manager";
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
});
