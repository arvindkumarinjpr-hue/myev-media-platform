import { randomUUID } from "crypto";
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { computeNextOccurrence, type QueueRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { QUEUE_REGISTRY } from "../queue/queue-registry.module";
import { WorkerHeartbeatService } from "../heartbeat/worker-heartbeat.service";
import { PrismaService } from "../prisma/prisma.service";
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

  constructor(
    private readonly config: ConfigService<WorkerConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    private readonly heartbeat: WorkerHeartbeatService,
    private readonly prisma: PrismaService,
    @InjectPinoLogger(SchedulerTickManager.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    this.connection.on("error", (error) => {
      this.logger.error({ err: error }, "Redis connection error");
    });

    this.tickQueue = new Queue(SCHEDULER_QUEUE_NAME, { connection: this.connection });

    this.tickWorker = new Worker(SCHEDULER_QUEUE_NAME, (job) => this.handleTick(job), { connection: this.connection, concurrency: 1 });
    this.tickWorker.on("error", (error) => {
      this.logger.error({ err: error }, "scheduler tick worker error");
    });

    const tickIntervalMs = this.config.get("schedulerTickIntervalMs", { infer: true });
    await this.tickQueue.upsertJobScheduler(SCHEDULER_ID, { every: tickIntervalMs, tz: "UTC" }, { name: TICK_JOB_NAME, data: {} });
    this.logger.info({ schedulerId: SCHEDULER_ID, tickIntervalMs }, "scheduler tick registered");
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

  private getDispatchQueue(queueName: string): Queue {
    if (!this.connection) {
      throw new Error("SchedulerTickManager.getDispatchQueue() called before onApplicationBootstrap");
    }
    let queue = this.dispatchQueues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      this.dispatchQueues.set(queueName, queue);
    }
    return queue;
  }

  async onApplicationShutdown(): Promise<void> {
    // Mirrors BullMqWorkerManager's own shutdown shape exactly. Shares
    // its DEFECT-1F-001 characteristic (an unbounded wait if Redis is
    // genuinely unreachable at shutdown time) — recorded under that
    // existing defect's scope per Revision 3 §7, not a new one.
    await this.tickWorker?.close();
    await this.tickQueue?.close();
    await Promise.all([...this.dispatchQueues.values()].map((queue) => queue.close()));
    await this.connection?.quit();
  }
}
