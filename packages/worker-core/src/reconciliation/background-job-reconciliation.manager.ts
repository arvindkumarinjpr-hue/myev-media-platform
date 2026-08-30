import { randomUUID } from "crypto";
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { boundedShutdown, type QueueRegistry, type ShutdownOutcomeTracker } from "@myev/shared";
import type { WorkerCoreConfig } from "../config/worker-core-config";
import { QUEUE_REGISTRY } from "../queue/queue-registry.token";
import { PrismaService } from "../prisma/prisma.service";
import { SHUTDOWN_TRACKER } from "../shutdown/shutdown.module";
import { BullMqWorkerManager, JobLifecycleConflictError } from "../bullmq/bullmq-worker.manager";
import type { BackgroundJob } from "../../../../apps/api/generated/prisma";

// Deliberately NOT one of the 9 QueueName categories, and never
// registered as a ProcessorManifest — identical reasoning to
// SchedulerTickManager's own SCHEDULER_QUEUE_NAME / OutboxRelayManager's
// own OUTBOX_RELAY_QUEUE_NAME: this is infrastructure, its own dedicated
// Worker consumes it, and BullMqWorkerManager's frozen pipeline is never
// involved.
const RECONCILIATION_QUEUE_NAME = "BACKGROUND_JOB_RECONCILIATION_INTERNAL";
const RECONCILIATION_SCHEDULER_ID = "background-job-reconciliation-primary";
const RECONCILIATION_TICK_JOB_NAME = "background-job.reconciliation.tick.v1";

const RECOVERY_ERROR_CODE = "WORKER_CRASH_DETECTED";
const RECOVERY_ERROR_MESSAGE_SAFE = "Job did not complete within its configured execution ceiling and was recovered after apparent worker failure.";
const RECOVERY_HISTORY_REASON = "worker_crash_recovery";

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * DEFECT-1F-006. Closes the stale-RUNNING gap proven in that defect's
 * engineering plan/proof: BullMQ's own native stalled-job redelivery
 * fires exactly once per crashed job and gets silently absorbed by
 * BullMqWorkerManager.process()'s own pickup guard (status='QUEUED'),
 * which reports success back to BullMQ — permanently ending any further
 * native recovery while the Postgres row stays RUNNING forever. This
 * manager is a periodic, infrastructure-only sweep — mirrors
 * SchedulerTickManager/OutboxRelayManager's own tick shape exactly (own
 * dedicated queue/Worker/connection, bounded degraded startup, bounded
 * shutdown) — never a second execution/retry engine. It only ever
 * detects candidates and hands them to BullMqWorkerManager's own,
 * unmodified retry/dead-letter decision (scheduleRetryOrDeadLetter);
 * every actual state transition is guarded by that method's own
 * attempts-fencing (DEFECT-1F-006), which is what makes concurrent
 * recovery attempts, and a stale execution resuming after recovery,
 * safe without any distributed lock.
 */
@Injectable()
export class BackgroundJobReconciliationManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection?: Redis;
  private tickQueue?: Queue;
  private tickWorker?: Worker;
  private registrationRetryTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  // Same rationale as SchedulerTickManager/OutboxRelayManager's identical
  // field: attemptRegistration is single-flight, so at most one of these
  // is ever set — exists solely so onApplicationShutdown can
  // force-disconnect an attempt that happens to be mid-flight.
  private inFlightRegistrationConnection?: Redis;

  constructor(
    private readonly config: ConfigService<WorkerCoreConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly bullMqWorkerManager: BullMqWorkerManager,
    @Inject(SHUTDOWN_TRACKER) private readonly shutdownTracker: ShutdownOutcomeTracker,
    @InjectPinoLogger(BackgroundJobReconciliationManager.name) private readonly logger: PinoLogger,
  ) {}

  /** Mirrors SchedulerTickManager/OutboxRelayManager's own bootstrap shape exactly — never blocks application bootstrap on Redis reachability. */
  async onApplicationBootstrap(): Promise<void> {
    this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    this.connection.on("error", (error) => {
      this.logger.error({ err: error }, "Redis connection error");
    });

    this.tickQueue = new Queue(RECONCILIATION_QUEUE_NAME, { connection: this.connection });
    this.tickWorker = new Worker(RECONCILIATION_QUEUE_NAME, (job) => this.handleTick(job), { connection: this.connection, concurrency: 1 });
    this.tickWorker.on("error", (error) => {
      this.logger.error({ err: error }, "background job reconciliation tick worker error");
    });

    const registered = await this.attemptRegistration();
    if (!registered) {
      this.scheduleRegistrationRetry();
    }
  }

  /** Reuses schedulerRegistrationTimeoutMs/schedulerRegistrationRetryIntervalMs — the same generic "how long to wait for one upsertJobScheduler call" concern OutboxRelayManager already reuses rather than duplicating as new config. */
  private async attemptRegistration(): Promise<boolean> {
    const timeoutMs = this.config.get("schedulerRegistrationTimeoutMs", { infer: true });
    const tickIntervalMs = this.config.get("backgroundJobReconciliationIntervalMs", { infer: true });

    const registrationConnection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    registrationConnection.on("error", () => undefined);
    const registrationQueue = new Queue(RECONCILIATION_QUEUE_NAME, { connection: registrationConnection });
    this.inFlightRegistrationConnection = registrationConnection;

    try {
      const outcome = await Promise.race([
        registrationQueue
          .upsertJobScheduler(RECONCILIATION_SCHEDULER_ID, { every: tickIntervalMs, tz: "UTC" }, { name: RECONCILIATION_TICK_JOB_NAME, data: {} })
          .then(() => "registered" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
      ]);
      if (outcome === "registered") {
        this.logger.info({ schedulerId: RECONCILIATION_SCHEDULER_ID, tickIntervalMs }, "background job reconciliation tick registered");
        return true;
      }
      this.logger.error(
        { event: "RECONCILIATION_REGISTRATION_FAILED", schedulerId: RECONCILIATION_SCHEDULER_ID, timeoutMs },
        "background job reconciliation registration did not complete within the configured deadline",
      );
      return false;
    } catch (error) {
      this.logger.error(
        { event: "RECONCILIATION_REGISTRATION_FAILED", schedulerId: RECONCILIATION_SCHEDULER_ID, err: { message: safeMessage(error) } },
        "background job reconciliation registration attempt failed",
      );
      return false;
    } finally {
      // queue.close() never disconnects a caller-supplied connection
      // (BullMQ treats it as caller-owned) — the explicit, synchronous
      // disconnect() is what actually matters. Same pattern as
      // SchedulerTickManager/OutboxRelayManager's identical finally block.
      registrationConnection.disconnect();
      await registrationQueue.close().catch(() => undefined);
      if (this.inFlightRegistrationConnection === registrationConnection) {
        this.inFlightRegistrationConnection = undefined;
      }
    }
  }

  private scheduleRegistrationRetry(): void {
    if (this.shuttingDown) return;
    const retryIntervalMs = this.config.get("schedulerRegistrationRetryIntervalMs", { infer: true });
    this.registrationRetryTimer = setTimeout(() => {
      if (this.shuttingDown) return;
      this.logger.warn({ event: "RECONCILIATION_REGISTRATION_RETRYING", schedulerId: RECONCILIATION_SCHEDULER_ID }, "retrying background job reconciliation registration");
      this.attemptRegistration()
        .then((registered) => {
          if (registered) {
            this.logger.info({ event: "RECONCILIATION_REGISTRATION_RECOVERED", schedulerId: RECONCILIATION_SCHEDULER_ID }, "background job reconciliation registration recovered");
            return;
          }
          this.scheduleRegistrationRetry();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { event: "RECONCILIATION_REGISTRATION_FAILED", schedulerId: RECONCILIATION_SCHEDULER_ID, err: { message: safeMessage(error) } },
            "background job reconciliation registration retry failed unexpectedly",
          );
          this.scheduleRegistrationRetry();
        });
    }, retryIntervalMs);
  }

  private async handleTick(_job: Job): Promise<void> {
    const correlationId = randomUUID();
    const startedAt = Date.now();
    this.logger.info({ event: "RECONCILIATION_TICK_STARTED", correlationId }, "background job reconciliation tick started");

    let candidates: BackgroundJob[] = [];
    let recovered = 0;
    let conflictSkipped = 0;
    let failed = 0;

    try {
      candidates = await this.findStaleCandidates();

      for (const candidate of candidates) {
        try {
          const outcome = await this.recoverCandidate(candidate, correlationId);
          if (outcome === "recovered") recovered++;
          if (outcome === "conflict-skipped") conflictSkipped++;
        } catch (error) {
          // Per-row isolation, mirrors SchedulerTickManager/
          // OutboxRelayManager's identical per-row try/catch — one bad
          // row never aborts the rest of the batch. Never logs payload.
          failed++;
          this.logger.error(
            {
              event: "RECONCILIATION_ROW_FAILED",
              jobPublicId: candidate.publicId,
              jobType: candidate.jobType,
              workspaceId: candidate.workspaceId,
              correlationId,
              err: { message: safeMessage(error) },
            },
            "reconciliation of one stale row failed",
          );
        }
      }

      this.logger.info(
        {
          event: "RECONCILIATION_TICK_COMPLETED",
          correlationId,
          candidates: candidates.length,
          recovered,
          conflictSkipped,
          failed,
          durationMs: Date.now() - startedAt,
        },
        "background job reconciliation tick completed",
      );
    } catch (error) {
      this.logger.error(
        {
          event: "RECONCILIATION_TICK_FAILED",
          correlationId,
          candidates: candidates.length,
          err: { message: safeMessage(error) },
          durationMs: Date.now() - startedAt,
        },
        "background job reconciliation tick failed",
      );
      // Not rethrown to BullMQ as a job failure needing retry — the next
      // tick, one interval away, is itself the retry mechanism (same
      // reasoning as SchedulerTickManager/OutboxRelayManager's own tick).
    }
  }

  /**
   * DEFECT-1F-006 authoritative candidate rule. The precise per-jobType
   * comparison against manifest.timeout happens here in application
   * code, since the manifest — and its timeout — lives only in this
   * process's own in-memory QueueRegistry, never in a SQL-queryable
   * form. A row whose jobType has no registered manifest is classified
   * stale immediately, REGARDLESS OF AGE: no currently-deployed
   * processor can legitimately own or complete it. Deliberately no
   * coarse SQL age pre-filter derived from "the largest known
   * manifest.timeout" — an earlier version of this method had exactly
   * that, and it silently excluded a freshly-started, unregistered-
   * jobType row (which must be stale immediately, per the rule above)
   * whenever it was younger than some OTHER, unrelated manifest's own
   * timeout — a real correctness bug, caught by this defect's own test
   * suite, not a hypothetical. `take: batchSize` combined with
   * `orderBy: startedAt asc` already bounds this query's cost and
   * naturally prioritizes the most-overdue rows first; RUNNING rows are
   * a small, transient set in a healthy system regardless. Read-only —
   * no claim, no lock, no lease; concurrency safety comes entirely from
   * BullMqWorkerManager's own attempts-fenced guarded writes
   * (DEFECT-1F-006), applied downstream in recoverCandidate.
   */
  private async findStaleCandidates(): Promise<BackgroundJob[]> {
    const batchSize = this.config.get("backgroundJobReconciliationBatchSize", { infer: true });

    const rows = await this.prisma.backgroundJob.findMany({
      where: { status: "RUNNING", startedAt: { not: null } },
      take: batchSize,
      orderBy: { startedAt: "asc" },
    });

    const now = Date.now();
    return rows.filter((row) => {
      if (!row.startedAt) return false;
      const manifest = this.registry.getManifest(row.jobType);
      if (!manifest) return true;
      return now - row.startedAt.getTime() >= manifest.timeout;
    });
  }

  /**
   * Reuses BullMqWorkerManager.scheduleRetryOrDeadLetter verbatim — see
   * this class's own doc comment and the DEFECT-1F-006 engineering proof
   * for why this is sufficient and safe: every field it needs (id,
   * attempts, maxAttempts) is exactly what findStaleCandidates already
   * read, and its own attempts-fenced guarded writes are what make two
   * racing reconciler ticks (or a reconciler racing a still-live
   * completion) safe without a distributed lock. A JobLifecycleConflictError
   * here means another writer (a second reconciler tick, or the row's
   * own legitimate owner) already resolved this exact stale attempt
   * between this candidate read and this call — benign, not a fault.
   */
  private async recoverCandidate(candidate: BackgroundJob, correlationId: string): Promise<"recovered" | "conflict-skipped"> {
    const staleForMs = candidate.startedAt ? Date.now() - candidate.startedAt.getTime() : undefined;
    const logFields = {
      jobPublicId: candidate.publicId,
      jobType: candidate.jobType,
      workspaceId: candidate.workspaceId,
      attempts: candidate.attempts,
      staleForMs,
      correlationId,
    };

    try {
      await this.bullMqWorkerManager.scheduleRetryOrDeadLetter(candidate, "TIMED_OUT", RECOVERY_ERROR_CODE, RECOVERY_ERROR_MESSAGE_SAFE, RECOVERY_HISTORY_REASON);
    } catch (error) {
      if (error instanceof JobLifecycleConflictError) {
        this.logger.info({ ...logFields, event: "RECONCILER_CONFLICT_SKIPPED" }, "stale row was already resolved by another writer before this recovery could apply — benign");
        return "conflict-skipped";
      }
      throw error;
    }

    this.logger.warn({ ...logFields, event: "RECONCILER_STALE_JOB_RECOVERED" }, "stale RUNNING background job recovered after apparent worker failure");
    return "recovered";
  }

  /** DEFECT-1F-001's bounded-shutdown pattern, reused unchanged — see BullMqWorkerManager/SchedulerTickManager/OutboxRelayManager's identical onApplicationShutdown for the full rationale. */
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.registrationRetryTimer) clearTimeout(this.registrationRetryTimer);
    if (this.inFlightRegistrationConnection) {
      this.inFlightRegistrationConnection.disconnect();
      this.inFlightRegistrationConnection = undefined;
    }

    const deadlineMs = this.config.get("redisShutdownDeadlineMs", { infer: true });

    const outcome = await boundedShutdown(
      async () => {
        await this.tickWorker?.close();
        await this.tickQueue?.close();
        await this.connection?.quit();
      },
      () => {
        this.tickWorker?.close(true).catch(() => undefined);
        this.connection?.disconnect();
      },
      deadlineMs,
    );

    this.shutdownTracker.record(BackgroundJobReconciliationManager.name, outcome);
    if (outcome !== "GRACEFUL") {
      const level = outcome === "FAILED" ? "error" : "warn";
      this.logger[level](
        { event: outcome === "FAILED" ? "REDIS_SHUTDOWN_FAILED" : "REDIS_SHUTDOWN_FORCED", component: BackgroundJobReconciliationManager.name, deadlineMs },
        outcome === "FAILED" ? "shutdown force-close also failed" : "graceful shutdown exceeded the deadline — forced disconnect",
      );
    }
  }
}
