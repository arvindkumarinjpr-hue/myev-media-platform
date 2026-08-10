import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Job, Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import {
  JobCancelledError,
  PermanentProcessorError,
  boundedShutdown,
  type ProcessorContext,
  type QueueRegistry,
  type ShutdownOutcomeTracker,
} from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { QUEUE_REGISTRY } from "../queue/queue-registry.module";
import { WorkerHeartbeatService } from "../heartbeat/worker-heartbeat.service";
import { PrismaService } from "../prisma/prisma.service";
import { SHUTDOWN_TRACKER } from "../shutdown/shutdown.module";
import { Prisma, type BackgroundJob } from "../../../api/generated/prisma";

class ProcessorTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`processor exceeded its configured timeout of ${timeoutMs}ms`);
    this.name = "ProcessorTimeoutError";
  }
}

/**
 * Thrown by the retry/dead-letter guarded writes below when the row is no
 * longer in the state this component expects to find it in — i.e. some
 * other write already changed it since this component last read it. This
 * is the "exactly one component schedules a retry" invariant made
 * concrete: every write that could schedule a retry or a terminal
 * transition is a conditional UPDATE keyed on the exact prior status it
 * requires, and a guard miss fails loudly here rather than silently
 * proceeding to dispatch a second, duplicate execution.
 */
export class JobLifecycleConflictError extends Error {
  constructor(backgroundJobId: string, detail: string) {
    super(`job lifecycle conflict for "${backgroundJobId}": ${detail}`);
    this.name = "JobLifecycleConflictError";
  }
}

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 600_000;

/**
 * Owns one BullMQ Worker per queue this process is assigned to
 * (config.queues). Dispatches a job to its ProcessorManifest's bound
 * handler and owns the background_jobs row's execution-side lifecycle —
 * the API's enqueue/cancel/retry endpoints (Module 1F Milestone 4's other
 * half) own the creation/cancellation-request/retry-request side.
 *
 * This class is the SOLE component that ever schedules an automatic
 * retry (transient-failure -> backoff -> re-enqueue). The API's manual
 * retry endpoint is a distinct, user-triggered path that only ever acts
 * on a row already in a terminal status (FAILED/TIMED_OUT) — by the time
 * a row is externally visible as terminal, this class's own retry-or-
 * dead-letter decision for that execution has already concluded (either
 * it scheduled a retry, in which case the row is QUEUED again, not
 * terminal; or it dead-lettered, in which case no further automatic
 * retry will ever occur for it). There is therefore no window where both
 * an automatic and a manual retry could be scheduled for the same failed
 * execution — and every write on both sides is additionally a guarded
 * conditional UPDATE (see JobLifecycleConflictError) so that even a
 * violation of that reasoning fails deterministically instead of
 * silently double-scheduling.
 *
 * A BullMQ job's `id` IS the background_jobs row's internal `id` (set at
 * enqueue time, and re-set identically on every automatic or manual
 * retry) — that identity is what lets this process correlate a dequeued
 * job back to its authoritative Postgres row without carrying any extra
 * metadata through job.data, which stays exactly the manifest's payload
 * shape.
 */
@Injectable()
export class BullMqWorkerManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection?: Redis;
  private readonly workers: Worker[] = [];
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly config: ConfigService<WorkerConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    private readonly heartbeat: WorkerHeartbeatService,
    private readonly prisma: PrismaService,
    @Inject(SHUTDOWN_TRACKER) private readonly shutdownTracker: ShutdownOutcomeTracker,
    @InjectPinoLogger(BullMqWorkerManager.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    // BullMQ requires this exact setting for its blocking commands.
    this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    // Node's EventEmitter throws (crashing the whole process) if an
    // 'error' event fires with zero listeners attached — without this,
    // a transient Redis blip (exactly the "Redis restart" scenario) would
    // kill this entire worker process, dropping every in-flight job on
    // it, rather than letting ioredis's own automatic reconnect (its
    // default retryStrategy) recover in place as intended.
    this.connection.on("error", (error) => {
      this.logger.error({ err: error }, "Redis connection error");
    });

    const queues = this.config.get("queues", { infer: true });
    const applicationVersion = this.config.get("applicationVersion", { infer: true });

    for (const queueName of queues) {
      const worker = new Worker(queueName, (job) => this.process(job, queueName, applicationVersion), {
        connection: this.connection,
        concurrency: 5,
      });

      worker.on("error", (error) => {
        this.logger.error({ err: error, queueName }, "BullMQ worker error");
      });

      this.workers.push(worker);
      this.logger.info({ queueName }, "BullMQ worker listening");
    }
  }

  private async process(job: Job, queueName: string, processorVersion: string): Promise<unknown> {
    const jobType = job.name;
    // A worker-scheduled automatic retry dispatches under
    // "<backgroundJobId>#retryN" (see scheduleRetry below), never the
    // bare id — strip it back off to recover the real correlation key.
    const backgroundJobId = String(job.id).split("#")[0];

    // Transition QUEUED -> RUNNING, guarded on the row still being QUEUED —
    // protects against a redelivered/duplicate BullMQ delivery re-running
    // an already-picked-up job. A guard miss is a benign no-op, not an
    // error: whoever delivered this duplicate already has a real outcome
    // recorded from the delivery that won the race. (A worker crash that
    // leaves a row stuck at RUNNING forever, with no process left to ever
    // transition it, was a known gap here — root-caused as DEFECT-1F-006:
    // BullMQ's own single native stalled-redelivery attempt gets silently
    // absorbed by this exact guard, treated as a successful completion by
    // BullMQ, so no further native recovery ever occurs. Now closed by
    // BackgroundJobReconciliationManager's periodic sweep, which detects a
    // RUNNING row past its own manifest's timeout and recovers it via
    // scheduleRetryOrDeadLetter — see that class and this file's own
    // attempts-fencing doc comments for why a stale execution that later
    // resumes can never corrupt a newer attempt's state.)
    const started = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.backgroundJob.updateMany({
        where: { id: backgroundJobId, status: "QUEUED" },
        data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 }, processorVersion },
      });
      if (updated.count === 0) return null;
      const row = await tx.backgroundJob.findUniqueOrThrow({ where: { id: backgroundJobId } });
      await tx.backgroundJobHistory.create({ data: { backgroundJobId, fromStatus: "QUEUED", toStatus: "RUNNING" } });
      return row;
    });

    if (!started) {
      this.logger.warn({ jobId: backgroundJobId, jobType, queueName }, "job was not in QUEUED state at pickup — skipping duplicate delivery");
      return { skipped: true };
    }

    const logContext = {
      jobId: backgroundJobId,
      correlationId: started.correlationId,
      workerId: this.heartbeat.workerId,
      queueName,
      jobType,
      processorVersion,
      attempt: started.attempts,
    };

    const manifest = this.registry.getManifest(jobType);
    const handler = this.registry.getHandler(jobType);
    if (!manifest || !handler) {
      // Structurally unreachable given this worker's own bootstrap
      // validation (every queue it opens has a bound handler for every
      // manifest in scope) — reachable only if something outside this
      // process enqueued a job.name this worker's registry never declared.
      // Permanent, not transient: no attempt count will ever fix an
      // unregistered job type, so this skips the retry decision entirely.
      this.logger.error(logContext, `no ProcessorManifest/handler bound for job type "${jobType}"`);
      await this.deadLetterImmediately(started, "FAILED", "UNKNOWN_JOB_TYPE", "No processor is registered for this job type.");
      throw new Error(`no ProcessorManifest/handler bound for job type "${jobType}"`);
    }

    const payload = plainToInstance(manifest.payloadDto, job.data);
    const validationErrors = await validate(payload);
    if (validationErrors.length > 0) {
      // Also permanent: the same payload will fail validation identically
      // on every retry.
      this.logger.error({ ...logContext, validationErrors }, "job payload failed validation");
      await this.deadLetterImmediately(started, "FAILED", "PAYLOAD_VALIDATION_FAILED", "Job payload failed validation.");
      throw new Error(`job payload for "${jobType}" failed validation: ${validationErrors.map((e) => e.toString()).join("; ")}`);
    }

    const context: ProcessorContext = {
      jobId: backgroundJobId,
      correlationId: started.correlationId,
      attempt: started.attempts,
      isCancelled: async () => {
        const current = await this.prisma.backgroundJob.findUnique({ where: { id: backgroundJobId }, select: { cancellationRequestedAt: true } });
        return current?.cancellationRequestedAt != null;
      },
    };

    this.logger.info(logContext, "job execution started");

    // Promise.race gives an engine-side timeout without touching
    // ProcessorHandler's frozen signature (no AbortSignal parameter) —
    // it does NOT cancel the losing promise (a JS/Node limitation), so a
    // handler that ignores this outcome keeps running in the background.
    // The permanent .catch() below exists solely to prevent an unhandled-
    // rejection warning if that background execution later rejects on its
    // own after we've already recorded the timeout outcome.
    const handlerPromise = handler(payload, context);
    handlerPromise.catch(() => undefined);

    let timer!: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new ProcessorTimeoutError(manifest.timeout)), manifest.timeout);
    });

    try {
      const result = await Promise.race([handlerPromise, timeoutPromise]);
      clearTimeout(timer);
      const safeResult = result === undefined ? null : (JSON.parse(JSON.stringify(result)) as object);
      const fenced = await this.runFenced(logContext, () => this.transitionTerminal(backgroundJobId, started.attempts, "COMPLETED", { resultMetadata: safeResult }));
      if (fenced.ok) this.logger.info(logContext, "job execution completed");
      return result;
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof JobCancelledError) {
        // Deliberate, not transient — cancellation is never auto-retried
        // regardless of attempts remaining.
        this.logger.info({ ...logContext, err: error }, "job execution cancelled");
        await this.transitionTerminal(backgroundJobId, started.attempts, "FAILED", {
          errorCode: "JOB_CANCELLED_BY_USER",
          errorMessageSafe: "Job was cancelled.",
          cancelledAt: new Date(),
        });
        throw error;
      }

      if (error instanceof PermanentProcessorError) {
        // Milestone 8.3 Phase 2 — a generic queue-engine capability, not
        // event-consumer-specific: any processor may throw this to
        // declare its own failure permanent, skipping
        // scheduleRetryOrDeadLetter's retry-budget decision entirely,
        // exactly like the UNKNOWN_JOB_TYPE/PAYLOAD_VALIDATION_FAILED
        // permanent-failure paths above (deadLetterImmediately, still
        // fenced on this attempt's own captured `started.attempts` via
        // transitionTerminal, attempts never re-incremented here).
        // Rethrown afterward so BullMQ's own bookkeeping marks this
        // specific delivery failed, not completed — every Queue.add()
        // call in this codebase already passes attempts: 1, so BullMQ
        // never natively retries this delivery regardless; Postgres
        // remains the sole retry/dead-letter authority.
        this.logger.error({ ...logContext, err: error }, "job execution failed permanently");
        await this.deadLetterImmediately(started, "FAILED", error.errorCode, error.errorMessageSafe);
        throw error;
      }

      const isTimeout = error instanceof ProcessorTimeoutError;
      const errorCode = isTimeout ? "PROCESSOR_TIMEOUT" : "PROCESSOR_ERROR";
      const errorMessageSafe = isTimeout ? "Job execution exceeded its configured timeout." : "Job execution failed.";
      const terminalStatus: "FAILED" | "TIMED_OUT" = isTimeout ? "TIMED_OUT" : "FAILED";

      this.logger.error({ ...logContext, err: error }, isTimeout ? "job execution timed out" : "job execution failed");
      await this.scheduleRetryOrDeadLetter(started, terminalStatus, errorCode, errorMessageSafe);
      throw error;
    }
  }

  /**
   * DEFECT-1F-006. Every execution-owned write in this file (scheduleRetry,
   * transitionTerminal, and therefore scheduleRetryOrDeadLetter/
   * deadLetterImmediately, which call them) is guarded on this attempt's
   * own captured `attempts` value in addition to status='RUNNING' — see
   * those methods' own doc comments and the DEFECT-1F-006 engineering
   * proof. A stale attempt that resumes after a newer attempt has
   * already taken ownership (or after the reconciliation manager has
   * already recovered the row) will have its write rejected:
   * JobLifecycleConflictError, zero rows affected, no history written.
   *
   * Deliberately used ONLY around the success path's own completion
   * write (`transitionTerminal(..., "COMPLETED", ...)`) below, not
   * around the failure/cancellation/permanent-failure paths. Those other
   * paths already have a genuine error of their own to report (the
   * handler's thrown error, `JobCancelledError`, an unknown job type, an
   * invalid payload) — a fencing rejection there means a DIFFERENT
   * writer raced this same live execution to a conflicting outcome, and
   * that conflict is itself the more informative, pre-existing signal to
   * surface (an established behavior this file's own duplicate-
   * scheduling-prevention tests already depend on) — swallowing it in
   * favor of the original, now-superseded error would hide a genuine
   * race behind a less useful message. The success path has no such
   * fallback error to preserve — a fenced-out completion is simply
   * obsolete, nothing else to report — so logging and stopping there is
   * correct without losing any existing signal.
   */
  private async runFenced<T>(logContext: Record<string, unknown>, action: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
    try {
      return { ok: true, value: await action() };
    } catch (error) {
      if (error instanceof JobLifecycleConflictError) {
        this.logger.warn(
          { ...logContext, event: "RECONCILER_STALE_ATTEMPT_FENCED" },
          "stale attempt's lifecycle write was fenced out — a newer attempt already owns this job",
        );
        return { ok: false };
      }
      throw error;
    }
  }

  /**
   * The single chokepoint every failure path (exception, timeout) routes
   * through to decide "retry with backoff" vs "dead-letter" — see the
   * class doc comment for the invariant this implements.
   *
   * DEFECT-1F-006: also the entry point BackgroundJobReconciliationManager
   * calls to recover a stale RUNNING row it has detected (see that
   * class). Not `private` for that reason — every value this method (and
   * its two internal helpers) needs is exactly what a caller's own
   * candidate read already produces (id, attempts, maxAttempts); it holds
   * no execution-local state a reconciler couldn't supply. `reason`
   * distinguishes an ordinary transient-failure retry
   * ("automatic_retry", the default, unchanged) from a reconciliation-
   * recovered one ("worker_crash_recovery") in the resulting
   * BackgroundJobHistory row — see scheduleRetry's own doc comment.
   */
  async scheduleRetryOrDeadLetter(
    job: BackgroundJob,
    terminalStatusOnExhaustion: "FAILED" | "TIMED_OUT",
    errorCode: string,
    errorMessageSafe: string,
    reason = "automatic_retry",
  ): Promise<void> {
    // Cancellation is authoritative even when the processor itself never
    // observed isCancelled() and threw an ordinary error instead (or the
    // cancel request landed in the narrow window between this worker's
    // last isCancelled() check and its failure) — a job the user asked to
    // stop must never be silently retried just because the failure that
    // happened to occur wasn't itself a JobCancelledError. Re-fetched
    // fresh here regardless of caller, so a reconciler-supplied `job`
    // snapshot (possibly read long before this call) is never trusted
    // for this specific decision.
    const current = await this.prisma.backgroundJob.findUnique({ where: { id: job.id }, select: { cancellationRequestedAt: true } });
    if (current?.cancellationRequestedAt) {
      await this.transitionTerminal(job.id, job.attempts, "FAILED", { errorCode: "JOB_CANCELLED_BY_USER", errorMessageSafe: "Job was cancelled.", cancelledAt: new Date() });
      return;
    }

    if (job.attempts < job.maxAttempts) {
      await this.scheduleRetry(job, errorCode, errorMessageSafe, reason);
    } else {
      await this.transitionTerminal(job.id, job.attempts, terminalStatusOnExhaustion, { errorCode, errorMessageSafe, deadLettered: true });
    }
  }

  /** Permanent failures (unknown job type, invalid payload) skip the attempts budget entirely — no retry could ever succeed. */
  private async deadLetterImmediately(job: BackgroundJob, status: "FAILED" | "TIMED_OUT", errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.transitionTerminal(job.id, job.attempts, status, { errorCode, errorMessageSafe, deadLettered: true });
  }

  /**
   * DEFECT-1F-006: the guard below is fenced on `attempts` in addition to
   * `status='RUNNING'` — see this class's own doc comment and the
   * DEFECT-1F-006 engineering proof. `job.attempts` is exactly the value
   * this specific execution attempt (or, for a reconciler-driven
   * recovery, the specific stale attempt being recovered) captured at
   * its own pickup transition; if the row's current `attempts` no longer
   * matches (a newer attempt has since started, or someone else already
   * resolved this exact stale attempt), this guard affects zero rows and
   * the caller receives JobLifecycleConflictError — never a double
   * requeue of the same logical retry.
   */
  private async scheduleRetry(job: BackgroundJob, errorCode: string, errorMessageSafe: string, reason = "automatic_retry"): Promise<void> {
    const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** job.attempts, MAX_BACKOFF_MS);

    const updated = await this.prisma.$transaction(async (tx) => {
      // The guard: only a row still RUNNING under THIS exact attempt
      // (status AND attempts both match) may be moved back to QUEUED.
      const result = await tx.backgroundJob.updateMany({
        where: { id: job.id, status: "RUNNING", attempts: job.attempts },
        data: { status: "QUEUED", errorCode, errorMessageSafe },
      });
      if (result.count === 0) return null;
      await tx.backgroundJobHistory.create({
        data: { backgroundJobId: job.id, fromStatus: "RUNNING", toStatus: "QUEUED", detail: { reason, attempt: job.attempts, maxAttempts: job.maxAttempts, nextAttemptDelayMs: delayMs } },
      });
      return true;
    });

    if (!updated) {
      // Something else already moved this row away from RUNNING between
      // our read and this write — the exactly-one-scheduler invariant
      // would be violated by proceeding to also dispatch a retry here.
      this.logger.error({ jobId: job.id, jobType: job.jobType }, "retry scheduling conflict — row was no longer RUNNING at write time");
      throw new JobLifecycleConflictError(job.id, "row was no longer RUNNING when scheduling an automatic retry");
    }

    const queue = this.getQueue(job.queueName);
    try {
      // Deliberately NOT the same jobId the just-finished attempt used
      // (contrast with BackgroundJobsService.requestRetry's manual-retry
      // path, which safely reuses the plain id — see its own comment for
      // why that case is different). This call happens WHILE BullMQ is
      // still awaiting this exact job's processor promise — process() is
      // still executing, it hasn't returned/thrown yet — so BullMQ has not
      // finalized the original delivery's state. Reusing (remove()+add() on)
      // the same id here raced BullMQ's own internal bookkeeping for that
      // id: BullMQ would go on to mark "the job with this id" failed
      // AFTER this call returns and process() finally throws, and with the
      // id reused, that finalization could land on the freshly-added
      // delayed retry instead of the concluded original — corrupting the
      // very thing this transaction just correctly scheduled. A distinct,
      // deterministic suffix avoids the collision entirely; process()
      // strips it back off to recover the real correlation key.
      await queue.add(job.jobType, job.payloadMetadata as object, {
        jobId: `${job.id}#retry${job.attempts}`,
        delay: delayMs,
        attempts: 1,
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      });
    } catch (dispatchError) {
      // The Postgres write above already committed (row is QUEUED) — a
      // synchronous dispatch failure here (Redis unreachable, connection
      // reset, etc.) would otherwise leave that row silently stuck QUEUED
      // forever, indistinguishable from a healthy pending job, with no
      // BullMQ entry that will ever redeliver it. Compensate by moving it
      // to a visible, terminal, dead-lettered state instead — a human can
      // manually retry once the queue is reachable again via the API's
      // own requestRetry(). This does NOT close the gap for a genuine
      // process crash in this exact window (nothing can run compensating
      // code if the process itself is gone) — that residual risk is the
      // known, inherent limitation of not yet having a transactional
      // outbox (Milestone 8), not something this catch block can fix.
      this.logger.error(
        { jobId: job.id, jobType: job.jobType, err: dispatchError },
        "retry dispatch failed after the Postgres retry-scheduling commit — compensating to dead-lettered",
      );
      await this.prisma.backgroundJob
        .updateMany({
          where: { id: job.id, status: "QUEUED" },
          data: { status: "FAILED", failedAt: new Date(), deadLetteredAt: new Date(), errorCode: "RETRY_DISPATCH_FAILED", errorMessageSafe: "Failed to dispatch the scheduled retry to the queue." },
        })
        .catch((compensationError: unknown) => {
          this.logger.error({ jobId: job.id, err: compensationError }, "compensating dead-letter write also failed — row remains stuck QUEUED");
        });
      throw dispatchError;
    }
  }

  /**
   * DEFECT-1F-006: fenced on `expectedAttempts` in addition to
   * `status='RUNNING'` — identical rationale to scheduleRetry's own doc
   * comment. Every caller passes the exact `attempts` value ITS OWN
   * attempt captured at pickup (`started.attempts` inside process(), or
   * `job.attempts` from scheduleRetryOrDeadLetter/deadLetterImmediately)
   * — never a value read fresh at write time, which would defeat the
   * fencing property entirely.
   */
  private async transitionTerminal(
    backgroundJobId: string,
    expectedAttempts: number,
    status: "COMPLETED" | "FAILED" | "TIMED_OUT",
    fields: { errorCode?: string; errorMessageSafe?: string; resultMetadata?: object | null; cancelledAt?: Date; deadLettered?: boolean } = {},
  ): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Guarded the same way as scheduleRetry: only a row still RUNNING
      // under THIS exact attempt (status AND attempts both match) may be
      // moved to a terminal status by this execution.
      const result = await tx.backgroundJob.updateMany({
        where: { id: backgroundJobId, status: "RUNNING", attempts: expectedAttempts },
        data: {
          status,
          completedAt: status === "COMPLETED" ? now : undefined,
          failedAt: status !== "COMPLETED" ? now : undefined,
          deadLetteredAt: fields.deadLettered ? now : undefined,
          // A successful COMPLETED explicitly clears any errorCode/
          // errorMessageSafe left over from an earlier failed attempt on
          // this same row (scheduleRetry sets them on every retry) —
          // otherwise a job that succeeds after retrying would still show
          // stale error fields from the attempt(s) that preceded it.
          errorCode: status === "COMPLETED" ? null : fields.errorCode,
          errorMessageSafe: status === "COMPLETED" ? null : fields.errorMessageSafe,
          resultMetadata: fields.resultMetadata === null ? Prisma.JsonNull : fields.resultMetadata,
          cancelledAt: fields.cancelledAt,
        },
      });
      if (result.count === 0) return false;
      await tx.backgroundJobHistory.create({
        data: { backgroundJobId, fromStatus: "RUNNING", toStatus: status, detail: fields.errorCode ? { errorCode: fields.errorCode, deadLettered: fields.deadLettered ?? false } : undefined },
      });
      return true;
    });

    if (!updated) {
      this.logger.error({ jobId: backgroundJobId, status }, "terminal transition conflict — row was no longer RUNNING at write time");
      throw new JobLifecycleConflictError(backgroundJobId, `row was no longer RUNNING when transitioning to ${status}`);
    }
  }

  /**
   * DEFECT-1F-006 CI blocker fix / DEFECT-1F-005 (partial). Verified
   * against the installed bullmq@6.0.8 source before choosing this fix
   * (node_modules/.pnpm/bullmq@6.0.8.../dist/cjs): `createRedisBackend`
   * (utils/create-backend.js) constructs this Queue's underlying
   * `RedisConnection` with `shared: isRedisInstance(opts.connection)` —
   * `true` here, since `this.connection` is a live `ioredis.Redis`
   * instance, not connection options. `QueueBase`'s own `close()`
   * (classes/queue-base.js) re-emits the backend's `'error'` event on
   * itself (`this.backend.on('error', (error) => this.emit('error',
   * error))`) — with zero listeners on the `Queue` object itself, that
   * `emit('error', ...)` throws (Node's EventEmitter contract), which is
   * exactly DEFECT-1F-005's mechanism. Attached once, at construction,
   * never re-attached on a cache hit (this branch only runs when a new
   * Queue is actually created) — logs safely (queueName only, no
   * URL/credentials), mirroring `worker.on("error", ...)`'s own
   * convention below.
   */
  private getQueue(queueName: string): Queue {
    if (!this.connection) {
      throw new Error("BullMqWorkerManager.getQueue() called before onApplicationBootstrap");
    }
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      queue.on("error", (error) => {
        this.logger.error({ err: error, queueName }, "BullMQ dispatch queue error");
      });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  /**
   * DEFECT-1F-001: Worker.close()/Queue.close()/connection.quit() are all
   * unbounded — if Redis is genuinely unreachable, each can hang
   * indefinitely (maxRetriesPerRequest: null means the underlying
   * command/reconnect loop never settles on its own). Bounded via
   * @myev/shared's boundedShutdown, mirroring the exact pattern already
   * proven for SchedulerTickManager's registration path (DEFECT-1F-004).
   *
   * The graceful phase is the same cooperative drain as before —
   * Worker.close() stops accepting new jobs and waits for in-flight jobs
   * to finish, which is the "graceful shutdown drains in-flight jobs"
   * requirement; hard process termination is out of scope by design (see
   * ProcessorManifest.cancelable's own doc comment) UNLESS the deadline
   * is exceeded, in which case the force phase below takes over.
   *
   * The force phase tears down every resource class this manager owns or
   * wraps — Worker.close(true) for BullMQ's own internally-duplicated
   * blocking connection (a Worker cannot issue non-blocking commands on a
   * connection parked in a blocking read, so it maintains its own
   * internal connection distinct from the one passed into its
   * constructor — disconnecting only the caller-owned `connection` field
   * would not necessarily close that internal one); queue.close() for
   * every cached `getQueue()` Queue (DEFECT-1F-006 CI blocker fix — the
   * graceful phase below already did this, but the force phase
   * previously left them untouched entirely, so a Queue created while
   * Redis was unreachable would survive shutdown and keep its own
   * error-forwarding chain alive indefinitely, well past this test/
   * process's own lifetime; verified against bullmq@6.0.8's own source
   * that `queue.close()` on a `shared: true` connection — which is what
   * `getQueue()` always constructs, since `this.connection` is a live
   * ioredis instance, not connection options — never awaits a Redis
   * round-trip: `RedisConnection.close()`'s entire disconnect/quit branch
   * is gated on `!this.extraOptions.shared` and is skipped outright here,
   * leaving only synchronous listener detachment, which is what actually
   * stops that Queue from re-emitting further connection errors); and
   * connection.disconnect() for the caller-owned primary connection this
   * class itself constructed. No call here is awaited: forceClose's
   * contract (boundedShutdown's second parameter) is synchronous by
   * design, so this method's own returned promise settles within
   * deadlineMs regardless of how long any of this actually takes to
   * settle internally — see boundedShutdown's own doc comment for why.
   * Each fire-and-forget call carries its own swallow-catch so a later
   * rejection can never produce an unhandled-rejection warning.
   */
  async onApplicationShutdown(): Promise<void> {
    const deadlineMs = this.config.get("redisShutdownDeadlineMs", { infer: true });

    const outcome = await boundedShutdown(
      async () => {
        await Promise.all(this.workers.map((worker) => worker.close()));
        await Promise.all([...this.queues.values()].map((queue) => queue.close()));
        await this.connection?.quit();
      },
      () => {
        for (const worker of this.workers) {
          worker.close(true).catch(() => undefined);
        }
        for (const queue of this.queues.values()) {
          queue.close().catch(() => undefined);
        }
        this.connection?.disconnect();
      },
      deadlineMs,
    );

    this.shutdownTracker.record(BullMqWorkerManager.name, outcome);
    if (outcome !== "GRACEFUL") {
      const level = outcome === "FAILED" ? "error" : "warn";
      this.logger[level](
        { event: outcome === "FAILED" ? "REDIS_SHUTDOWN_FAILED" : "REDIS_SHUTDOWN_FORCED", component: BullMqWorkerManager.name, deadlineMs },
        outcome === "FAILED" ? "shutdown force-close also failed" : "graceful shutdown exceeded the deadline — forced disconnect",
      );
    }
  }
}
