import { randomUUID } from "crypto";
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { computeNextOccurrence, boundedShutdown, type QueueRegistry, type ShutdownOutcomeTracker } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { QUEUE_REGISTRY } from "../queue/queue-registry.module";
import { WorkerHeartbeatService } from "@myev/worker-core";
import { PrismaService } from "@myev/worker-core";
import { SHUTDOWN_TRACKER } from "@myev/worker-core";
import { Prisma, type ScheduledJob } from "../../../api/generated/prisma";
import { isExpectedIdempotencyViolation } from "./idempotency-violation";

// Deliberately NOT one of the 9 QueueName categories, and never
// registered as a ProcessorManifest — this is the resolution to the
// process()-guard conflict identified during planning (Revision 1/3):
// BullMqWorkerManager.process() requires every job it dequeues to
// already have a matching background_jobs row, which this tick
// deliberately does not (it is infrastructure, not a business job).
// Living on its own queue, consumed by its own dedicated Worker, means
// BullMqWorkerManager's frozen pipeline is never involved and never
// touched.
const SCHEDULER_QUEUE_NAME = "SCHEDULER_INTERNAL";
const SCHEDULER_ID = "scheduler-tick-primary";
const TICK_JOB_NAME = "scheduler.tick.v1";

interface ClaimedOccurrence {
  schedule: ScheduledJob;
  dueOccurrence: Date;
}

/**
 * Module 1F Milestone 7 (Scheduler Foundation), Revision 3. Lives inside
 * the existing apps/worker NestJS application — no new deployable, no
 * new container (§7). Owns its own BullMQ queue/Worker/Redis connection,
 * structurally independent of BullMqWorkerManager (frozen, never
 * touched). Never executes business work directly: every real scheduled
 * execution becomes an ordinary background_jobs row via the identical
 * row-then-BullMQ pattern every other job in this system already uses,
 * dispatched to the queue BullMqWorkerManager's own Workers already
 * consume — this class only ever decides WHICH schedules are due and
 * creates that row; BullMqWorkerManager's untouched process() pipeline
 * does the actual execution.
 */
@Injectable()
export class SchedulerTickManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection?: Redis;
  private tickQueue?: Queue;
  private tickWorker?: Worker;
  private readonly dispatchQueues = new Map<string, Queue>();
  // DEFECT-1F-004 (bootstrap can hang indefinitely when Redis is
  // unreachable — bounded degraded startup, see this file's own class
  // doc comment): tracks the background retry loop so onApplicationShutdown
  // can cancel it deterministically, and gates the loop against
  // scheduling a new attempt after shutdown has begun.
  private registrationRetryTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  // Tracks the CURRENTLY in-flight attempt's own dedicated connection
  // (attemptRegistration is single-flight by construction — the retry
  // loop never starts a new attempt until the previous one's promise has
  // settled — so at most one of these is ever set at a time). Exists
  // solely so onApplicationShutdown can force-disconnect an attempt that
  // happens to be mid-flight at shutdown, rather than leaving it to
  // settle on its own bounded schedule after shutdown has already
  // returned — required so "shutdown cancels ALL registration
  // resources" holds even for the in-flight case, not just already-
  // scheduled future retries.
  private inFlightRegistrationConnection?: Redis;

  constructor(
    private readonly config: ConfigService<WorkerConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    private readonly heartbeat: WorkerHeartbeatService,
    private readonly prisma: PrismaService,
    @Inject(SHUTDOWN_TRACKER) private readonly shutdownTracker: ShutdownOutcomeTracker,
    @InjectPinoLogger(SchedulerTickManager.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * DEFECT-1F-004: `queue.upsertJobScheduler()` is a real Redis round-trip
   * that, empirically confirmed against a genuinely unreachable Redis
   * (real infrastructure, not simulated), never settles — neither
   * resolves nor rejects — because `maxRetriesPerRequest: null` (required
   * by BullMQ for its blocking commands) means a queued command waits
   * forever for a connection ioredis's own default retryStrategy never
   * stops attempting. Previously awaited directly here, which blocked
   * NestJS's entire application-bootstrap sequence indefinitely whenever
   * Redis was down at startup.
   *
   * Fixed as bounded degraded startup (chosen over fail-fast because it
   * is the ALREADY-established policy for this exact process:
   * BullMqWorkerManager.onApplicationBootstrap is not even `async` — it
   * never blocks bootstrap on Redis reachability at all, handling
   * connectivity purely asynchronously via its own 'error' listener.
   * Fail-fast here would be a new, inconsistent policy for this worker).
   * The tick Worker starts immediately regardless of registration
   * outcome, exactly mirroring that precedent — application bootstrap
   * always completes; a confirmed registration follows independently,
   * bounded per attempt, retried on a fixed interval in the background
   * until it succeeds. No business/schedule state ever lives in Redis
   * (Revision 3 §5), so a delayed registration loses nothing — the next
   * successful attempt (first or retried) restores it completely.
   *
   * `this.connection`/`this.tickQueue` constructed below are used ONLY
   * for the tick Worker and dispatch queues — never for registration
   * attempts themselves (see attemptRegistration's own doc comment for
   * why: each attempt gets its own dedicated, disposable connection, so
   * a timed-out attempt can be fully torn down without touching the
   * long-lived connection the Worker depends on).
   */
  async onApplicationBootstrap(): Promise<void> {
    this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    this.connection.on("error", (error) => {
      this.logger.error({ err: error }, "Redis connection error");
    });

    this.tickQueue = new Queue(SCHEDULER_QUEUE_NAME, { connection: this.connection });

    // Mirrors BullMqWorkerManager's own bootstrap exactly: the Worker
    // itself never awaits a Redis round-trip to start (BullMQ connects
    // and begins consuming asynchronously in the background) — it is
    // already listening the moment registration (first attempt or a
    // later retry) eventually succeeds.
    this.tickWorker = new Worker(SCHEDULER_QUEUE_NAME, (job) => this.handleTick(job), { connection: this.connection, concurrency: 1 });
    this.tickWorker.on("error", (error) => {
      this.logger.error({ err: error }, "scheduler tick worker error");
    });

    const registered = await this.attemptRegistration();
    if (!registered) {
      this.scheduleRegistrationRetry();
    }
  }

  /**
   * DEFECT-1F-004 (final correction): Promise.race alone bounds this
   * method's own wait, but does nothing to the abandoned
   * upsertJobScheduler() call itself — empirically proven (real
   * unreachable Redis) that neither ioredis's own `disconnect()` nor
   * BullMQ's `Queue.close(true)` reliably unblocks a command already
   * sitting in ioredis's offline queue while the connection is mid
   * reconnect-cycle; both can leave the connection's `waitUntilReady()`
   * promise permanently stuck on "reconnecting", never emitting the
   * 'end' event that BullMQ's own `RedisConnection.close()` needs.
   * Reusing the long-lived, forever-retrying `this.connection` (as the
   * previous version of this fix did) meant every retry issued another
   * upsertJobScheduler call against that SAME connection, each one
   * joining the last, permanently: pending promises, offline-queued
   * commands, and (on eventual recovery) a burst of redundant upserts
   * would all accumulate without bound for the duration of an outage.
   *
   * Fixed by giving EVERY attempt its own dedicated, single-use
   * connection/Queue — never `this.connection` (which tickWorker/
   * tickQueue/dispatchQueues depend on and which must keep retrying
   * forever, unchanged, exactly like BullMqWorkerManager's own
   * connection — it is never touched here). Once an attempt's deadline
   * expires, its own dedicated connection is disconnected — proven
   * empirically (5 consecutive real-unreachable-Redis cycles) that this
   * reliably halts THAT connection's reconnect loop and keeps the
   * process's active handle count flat, with zero growth across cycles,
   * even though the abandoned command's own promise never technically
   * settles. We do not try to force it to settle; we simply ensure
   * nothing keeps a reference to it or its connection once we give up,
   * so both become ordinary, non-leaking, unreachable garbage. This
   * guarantees at most one LIVE (i.e., still trying to reconnect)
   * registration connection exists at any instant: the previous
   * attempt's is always torn down before the next is created.
   */
  private async attemptRegistration(): Promise<boolean> {
    const timeoutMs = this.config.get("schedulerRegistrationTimeoutMs", { infer: true });
    const tickIntervalMs = this.config.get("schedulerTickIntervalMs", { infer: true });

    const registrationConnection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    // Silent: an unreachable Redis can cycle ECONNREFUSED many times
    // within a single bounded attempt (ioredis's own fast early retry
    // backoff), and this connection is discarded the moment this method
    // returns — attemptRegistration's own single SCHEDULER_REGISTRATION_FAILED
    // log per attempt is the intended, bounded signal, not a log line
    // per underlying reconnect cycle. An 'error' listener is still
    // required — ioredis throws if an 'error' event has zero listeners.
    registrationConnection.on("error", () => undefined);
    const registrationQueue = new Queue(SCHEDULER_QUEUE_NAME, { connection: registrationConnection });
    // Published for onApplicationShutdown to reach — see this field's own
    // doc comment on why an in-flight attempt needs to be independently
    // reachable, not just the future retry timer.
    this.inFlightRegistrationConnection = registrationConnection;

    try {
      const outcome = await Promise.race([
        registrationQueue.upsertJobScheduler(SCHEDULER_ID, { every: tickIntervalMs, tz: "UTC" }, { name: TICK_JOB_NAME, data: {} }).then(() => "registered" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
      ]);
      if (outcome === "registered") {
        this.logger.info({ schedulerId: SCHEDULER_ID, tickIntervalMs }, "scheduler tick registered");
        return true;
      }
      this.logger.error({ event: "SCHEDULER_REGISTRATION_FAILED", schedulerId: SCHEDULER_ID, timeoutMs }, "scheduler registration did not complete within the configured deadline");
      return false;
    } catch (error) {
      // Never logs the connection URL/credentials — only the schedulerId
      // and a safe error message.
      this.logger.error(
        { event: "SCHEDULER_REGISTRATION_FAILED", schedulerId: SCHEDULER_ID, err: { message: error instanceof Error ? error.message : String(error) } },
        "scheduler registration attempt failed",
      );
      return false;
    } finally {
      // Terminate THIS attempt's own resources before returning — the
      // caller (scheduleRegistrationRetry) only ever schedules the next
      // attempt after this method's promise settles, so "only after
      // cleanup completes may another attempt be scheduled" is
      // structural, not incidental. queue.close() never disconnects a
      // connection we constructed ourselves and handed in (BullMQ treats
      // an externally-supplied ioredis instance as caller-owned/"shared"
      // and skips disconnecting it entirely, regardless of its own
      // internal force flag — confirmed by inspection of
      // RedisConnection.close() and empirically: an externally-owned
      // connection is never touched by it), so this explicit,
      // synchronous disconnect() is the operation that actually matters;
      // close() below only releases BullMQ's own internal bookkeeping
      // (listeners, closed/closing state) and is deliberately NOT the
      // public queue.disconnect() — that method defaults to awaiting the
      // connection's own 'end' event, which (per this method's own doc
      // comment) can never fire in exactly the scenario this fix exists
      // for, and would reintroduce an unbounded await here.
      registrationConnection.disconnect();
      await registrationQueue.close().catch(() => undefined);
      // Only clear the field if it's still THIS attempt's own connection
      // — onApplicationShutdown may have already raced in, force-
      // disconnected it, and moved on; calling disconnect() twice on the
      // same ioredis instance is a harmless no-op (confirmed by
      // inspection: it just re-clears an already-cleared reconnect
      // timer and re-invokes connector.disconnect() on an already-dead
      // stream), so there is no ordering hazard either way.
      if (this.inFlightRegistrationConnection === registrationConnection) {
        this.inFlightRegistrationConnection = undefined;
      }
    }
  }

  /** Fixed-interval retry, not aggressive spinning — each attempt is itself bounded, and the next is only scheduled after the current one has fully settled (never overlapping). Stops permanently on first success. */
  private scheduleRegistrationRetry(): void {
    if (this.shuttingDown) return;
    const retryIntervalMs = this.config.get("schedulerRegistrationRetryIntervalMs", { infer: true });
    this.registrationRetryTimer = setTimeout(() => {
      if (this.shuttingDown) return;
      this.logger.warn({ event: "SCHEDULER_REGISTRATION_RETRYING", schedulerId: SCHEDULER_ID }, "retrying scheduler registration");
      this.attemptRegistration()
        .then((registered) => {
          if (registered) {
            this.logger.info({ event: "SCHEDULER_REGISTRATION_RECOVERED", schedulerId: SCHEDULER_ID }, "scheduler registration recovered");
            return;
          }
          this.scheduleRegistrationRetry();
        })
        .catch((error: unknown) => {
          this.logger.error({ event: "SCHEDULER_REGISTRATION_FAILED", schedulerId: SCHEDULER_ID, err: { message: error instanceof Error ? error.message : String(error) } }, "scheduler registration retry failed unexpectedly");
          this.scheduleRegistrationRetry();
        });
    }, retryIntervalMs);
  }

  private async handleTick(_job: Job): Promise<void> {
    const correlationId = randomUUID();
    const workerId = this.heartbeat.workerId;
    const startedAt = Date.now();
    this.logger.info({ event: "SCHEDULER_TICK_STARTED", workerId, correlationId }, "scheduler tick started");

    let schedulesDispatched = 0;
    let schedulesSkipped = 0;
    let schedulesFailed = 0;
    let claimed: ClaimedOccurrence[] = [];

    try {
      claimed = await this.claimDueSchedules();

      for (const occurrence of claimed) {
        try {
          const dispatched = await this.dispatchOccurrence(occurrence, correlationId);
          if (dispatched) schedulesDispatched++;
          else schedulesSkipped++;
        } catch (error) {
          // Per-row isolation (Revision 3 §7/mandatory error isolation):
          // caught here so one bad schedule never aborts the rest of the
          // batch. Never logs payload — only the schedule's own
          // identifying metadata and a safe error message.
          schedulesFailed++;
          this.logger.error(
            {
              event: "SCHEDULE_DISPATCH_FAILED",
              schedulePublicId: occurrence.schedule.publicId,
              workspaceId: occurrence.schedule.workspaceId,
              jobType: occurrence.schedule.jobType,
              correlationId,
              err: { message: error instanceof Error ? error.message : String(error) },
            },
            "schedule dispatch failed",
          );
        }
      }

      this.logger.info(
        {
          event: "SCHEDULER_TICK_COMPLETED",
          workerId,
          correlationId,
          schedulesScanned: claimed.length,
          schedulesDue: claimed.length,
          schedulesDispatched,
          schedulesSkipped,
          schedulesFailed,
          durationMs: Date.now() - startedAt,
        },
        "scheduler tick completed",
      );
    } catch (error) {
      this.logger.error(
        {
          event: "SCHEDULER_TICK_FAILED",
          workerId,
          correlationId,
          schedulesScanned: claimed.length,
          err: { message: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startedAt,
        },
        "scheduler tick failed",
      );
      // Not rethrown to BullMQ as a job failure needing retry — the next
      // tick, one interval away, is itself the retry mechanism (Revision
      // 3's established reasoning for transient infrastructure errors).
    }
  }

  /**
   * SELECT ... FOR UPDATE SKIP LOCKED (Revision 3 §12) claims a batch of
   * due schedules and, within the SAME transaction, advances each one's
   * nextRunAt fresh from (cronExpression, timezone, Postgres's own
   * now()) — never incremented from the stale prior value (§9's locked
   * misfire policy) — and bumps lastRunAt/version. This is the only step
   * requiring cross-row atomicity; per-row dispatch (below) deliberately
   * runs in separate transactions afterward so one row's failure can
   * never roll back another row's already-claimed advance.
   */
  private async claimDueSchedules(): Promise<ClaimedOccurrence[]> {
    const batchSize = this.config.get("schedulerBatchSize", { infer: true });

    return this.prisma.$transaction(async (tx) => {
      const [{ now: pgNow }] = await tx.$queryRaw<{ now: Date }[]>`SELECT now() as now`;

      const dueRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM scheduled_jobs
        WHERE enabled = true AND deleted_at IS NULL AND next_run_at <= ${pgNow}
        ORDER BY next_run_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `;
      if (dueRows.length === 0) return [];

      const ids = dueRows.map((row) => row.id);
      const schedules = await tx.scheduledJob.findMany({ where: { id: { in: ids } } });

      const claimed: ClaimedOccurrence[] = [];
      for (const schedule of schedules) {
        // Non-null: this row was only selected because next_run_at was
        // set and <= pgNow.
        const dueOccurrence = schedule.nextRunAt as Date;
        const nextRunAt = computeNextOccurrence(schedule.cronExpression, schedule.timezone, pgNow);

        await tx.scheduledJob.update({
          where: { id: schedule.id },
          data: { nextRunAt, lastRunAt: pgNow, version: { increment: 1 } },
        });

        claimed.push({ schedule, dueOccurrence });
      }
      return claimed;
    });
  }

  /**
   * Duplicates the identical enqueue() algorithm, Worker-local (already-
   * approved resolution — see idempotency-violation.ts's own doc
   * comment): idempotency-key check, transactional background_jobs row +
   * history creation, then BullMQ dispatch with the same compensating-
   * write-on-failure pattern already proven in
   * BackgroundJobsService.enqueue() and BullMqWorkerManager.scheduleRetry().
   * Returns false for a permanent validation failure (row is auto-
   * disabled, not thrown) or a replay (already dispatched by a prior
   * tick/redelivery) — true only on a genuine new dispatch.
   */
  private async dispatchOccurrence(occurrence: ClaimedOccurrence, correlationId: string): Promise<boolean> {
    const { schedule, dueOccurrence } = occurrence;

    const manifest = this.registry.getManifest(schedule.jobType);
    if (!manifest) {
      await this.autoDisable(schedule, "SCHEDULE_JOB_TYPE_UNKNOWN", "This schedule's job type is no longer registered.");
      return false;
    }

    const payload = plainToInstance(manifest.payloadDto, schedule.payloadMetadata);
    const validationErrors = await validate(payload);
    if (validationErrors.length > 0) {
      await this.autoDisable(schedule, "SCHEDULE_PAYLOAD_INVALID", "This schedule's payload no longer validates against the current job contract.");
      return false;
    }

    const idempotencyKey = `schedule:${schedule.id}:${dueOccurrence.toISOString()}`;

    let row: { id: string };
    let replay = false;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.backgroundJob.create({
          data: {
            workspaceId: schedule.workspaceId,
            jobType: schedule.jobType,
            queueName: manifest.queue,
            payloadMetadata: payload as unknown as Prisma.InputJsonValue,
            maxAttempts: manifest.defaultRetryPolicy?.maxAttempts ?? 1,
            idempotencyKey,
            correlationId,
          },
        });
        await tx.backgroundJobHistory.create({ data: { backgroundJobId: created.id, toStatus: "QUEUED" } });
        return created;
      });
    } catch (error) {
      const existing = isExpectedIdempotencyViolation(error, schedule.workspaceId)
        ? await this.prisma.backgroundJob.findFirst({ where: { workspaceId: schedule.workspaceId, idempotencyKey } })
        : null;
      if (!existing) throw error;
      row = existing;
      replay = true;
    }

    if (replay) return false;

    try {
      await this.getDispatchQueue(manifest.queue).add(schedule.jobType, payload, {
        jobId: row.id,
        attempts: 1,
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      });
    } catch (dispatchError) {
      this.logger.error(
        { jobId: row.id, jobType: schedule.jobType, err: { message: dispatchError instanceof Error ? dispatchError.message : String(dispatchError) } },
        "scheduled dispatch failed after Postgres commit — compensating to failed",
      );
      await this.prisma.backgroundJob
        .update({ where: { id: row.id }, data: { status: "FAILED", failedAt: new Date(), errorCode: "ENQUEUE_DISPATCH_FAILED", errorMessageSafe: "Failed to dispatch job to the queue." } })
        .catch(() => undefined);
      throw dispatchError;
    }

    return true;
  }

  /**
   * The deterministic policy for a permanently-invalid schedule
   * definition (Revision 3 §7): disable it, record a safe operational
   * error, bump version. Never re-attempted every tick forever. Not an
   * audit_logs entry — system-initiated, captured by this same
   * structured log line, mirroring the SCHEDULE_TRIGGERED/SKIPPED
   * exclusion reasoning (§11).
   */
  private async autoDisable(schedule: ScheduledJob, errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.prisma.scheduledJob.update({
      where: { id: schedule.id },
      data: { enabled: false, lastErrorCode: errorCode, lastErrorMessageSafe: errorMessageSafe, version: { increment: 1 } },
    });
    this.logger.error(
      { event: "SCHEDULE_AUTO_DISABLED", schedulePublicId: schedule.publicId, workspaceId: schedule.workspaceId, jobType: schedule.jobType, errorCode },
      "schedule permanently invalid — auto-disabled",
    );
  }

  /**
   * DEFECT-1F-005 (final call site). Same rationale as
   * BullMqWorkerManager.getQueue()'s own doc comment: this Queue's
   * underlying RedisConnection is constructed with `shared: true`
   * (verified against the installed bullmq@6.0.8 source — `this.connection`
   * is a live ioredis instance, not connection options), so a zero-listener
   * 'error' emission on the Queue object itself would otherwise be
   * possible. Attached once, at construction, never re-attached on a
   * cache hit.
   */
  private getDispatchQueue(queueName: string): Queue {
    if (!this.connection) {
      throw new Error("SchedulerTickManager.getDispatchQueue() called before onApplicationBootstrap");
    }
    let queue = this.dispatchQueues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      queue.on("error", (error) => {
        this.logger.error({ err: error, queueName }, "scheduler dispatch queue error");
      });
      this.dispatchQueues.set(queueName, queue);
    }
    return queue;
  }

  async onApplicationShutdown(): Promise<void> {
    // DEFECT-1F-004: stop the background registration-retry loop first —
    // otherwise a still-pending retry timer either fires after shutdown
    // has begun (scheduling yet another attempt on a connection about to
    // be torn down) or simply leaks, keeping the process's event loop
    // alive with no other purpose.
    this.shuttingDown = true;
    if (this.registrationRetryTimer) clearTimeout(this.registrationRetryTimer);
    // Also force-disconnect an attempt that happens to be mid-flight
    // right now (bounded by its own timeout, so it would settle on its
    // own eventually — but "shutdown cancels ALL registration
    // resources" should hold immediately, not just for already-scheduled
    // future retries). attemptRegistration's own finally block still
    // runs afterward and finds this connection already gone — a
    // harmless no-op, not an error (see that method's own comment).
    if (this.inFlightRegistrationConnection) {
      this.inFlightRegistrationConnection.disconnect();
      this.inFlightRegistrationConnection = undefined;
    }

    // DEFECT-1F-001: mirrors BullMqWorkerManager's own bounded-shutdown
    // shape exactly (see that class's identical onApplicationShutdown
    // doc comment for the full rationale — Worker.close(true) for
    // BullMQ's own internally-duplicated blocking connection,
    // connection.disconnect() for this class's own caller-owned one,
    // neither awaited in the force phase so this method's own promise
    // stays bounded by deadlineMs regardless of how long BullMQ's
    // internal teardown takes). The registration-path resources above
    // are already unconditionally cleared before this point (DEFECT-1F-
    // 004) — this phase only concerns the main tick-worker/dispatch
    // connection, previously recorded as sharing DEFECT-1F-001's scope
    // without yet being fixed.
    const deadlineMs = this.config.get("redisShutdownDeadlineMs", { infer: true });

    const outcome = await boundedShutdown(
      async () => {
        await this.tickWorker?.close();
        await this.tickQueue?.close();
        await Promise.all([...this.dispatchQueues.values()].map((queue) => queue.close()));
        await this.connection?.quit();
      },
      () => {
        this.tickWorker?.close(true).catch(() => undefined);
        for (const queue of this.dispatchQueues.values()) {
          queue.close().catch(() => undefined);
        }
        this.connection?.disconnect();
      },
      deadlineMs,
    );

    this.shutdownTracker.record(SchedulerTickManager.name, outcome);
    if (outcome !== "GRACEFUL") {
      const level = outcome === "FAILED" ? "error" : "warn";
      this.logger[level](
        { event: outcome === "FAILED" ? "REDIS_SHUTDOWN_FAILED" : "REDIS_SHUTDOWN_FORCED", component: SchedulerTickManager.name, deadlineMs },
        outcome === "FAILED" ? "shutdown force-close also failed" : "graceful shutdown exceeded the deadline — forced disconnect",
      );
    }
  }
}
