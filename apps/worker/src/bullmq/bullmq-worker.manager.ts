import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Job, Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { JobCancelledError, type ProcessorContext, type QueueRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { QUEUE_REGISTRY } from "../queue/queue-registry.module";
import { WorkerHeartbeatService } from "../heartbeat/worker-heartbeat.service";
import { PrismaService } from "../prisma/prisma.service";
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
    @InjectPinoLogger(BullMqWorkerManager.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    // BullMQ requires this exact setting for its blocking commands.
    this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });

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
    // transition it, is a known, deliberately out-of-scope gap here —
    // reconciling stale RUNNING rows is a periodic-sweep concern for a
    // future Scheduler foundation piece, not something this per-job
    // execution path can detect about itself. Critically, that gap is an
    // UNDER-scheduling risk, never a duplicate-scheduling one: a stuck row
    // simply never retries, it never retries twice.)
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
      await this.transitionTerminal(backgroundJobId, "COMPLETED", { resultMetadata: safeResult });
      this.logger.info(logContext, "job execution completed");
      return result;
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof JobCancelledError) {
        // Deliberate, not transient — cancellation is never auto-retried
        // regardless of attempts remaining.
        this.logger.info({ ...logContext, err: error }, "job execution cancelled");
        await this.transitionTerminal(backgroundJobId, "FAILED", {
          errorCode: "JOB_CANCELLED_BY_USER",
          errorMessageSafe: "Job was cancelled.",
          cancelledAt: new Date(),
        });
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
   * The single chokepoint every failure path (exception, timeout) routes
   * through to decide "retry with backoff" vs "dead-letter" — see the
   * class doc comment for the invariant this implements.
   */
  private async scheduleRetryOrDeadLetter(
    job: BackgroundJob,
    terminalStatusOnExhaustion: "FAILED" | "TIMED_OUT",
    errorCode: string,
    errorMessageSafe: string,
  ): Promise<void> {
    // Cancellation is authoritative even when the processor itself never
    // observed isCancelled() and threw an ordinary error instead (or the
    // cancel request landed in the narrow window between this worker's
    // last isCancelled() check and its failure) — a job the user asked to
    // stop must never be silently retried just because the failure that
    // happened to occur wasn't itself a JobCancelledError.
    const current = await this.prisma.backgroundJob.findUnique({ where: { id: job.id }, select: { cancellationRequestedAt: true } });
    if (current?.cancellationRequestedAt) {
      await this.transitionTerminal(job.id, "FAILED", { errorCode: "JOB_CANCELLED_BY_USER", errorMessageSafe: "Job was cancelled.", cancelledAt: new Date() });
      return;
    }

    if (job.attempts < job.maxAttempts) {
      await this.scheduleRetry(job, errorCode, errorMessageSafe);
    } else {
      await this.transitionTerminal(job.id, terminalStatusOnExhaustion, { errorCode, errorMessageSafe, deadLettered: true });
    }
  }

  /** Permanent failures (unknown job type, invalid payload) skip the attempts budget entirely — no retry could ever succeed. */
  private async deadLetterImmediately(job: BackgroundJob, status: "FAILED" | "TIMED_OUT", errorCode: string, errorMessageSafe: string): Promise<void> {
    await this.transitionTerminal(job.id, status, { errorCode, errorMessageSafe, deadLettered: true });
  }

  private async scheduleRetry(job: BackgroundJob, errorCode: string, errorMessageSafe: string): Promise<void> {
    const delayMs = Math.min(BASE_BACKOFF_MS * 2 ** job.attempts, MAX_BACKOFF_MS);

    const updated = await this.prisma.$transaction(async (tx) => {
      // The guard: only a row still RUNNING (i.e. still this exact
      // execution's to decide) may be moved back to QUEUED for retry.
      const result = await tx.backgroundJob.updateMany({
        where: { id: job.id, status: "RUNNING" },
        data: { status: "QUEUED", errorCode, errorMessageSafe },
      });
      if (result.count === 0) return null;
      await tx.backgroundJobHistory.create({
        data: { backgroundJobId: job.id, fromStatus: "RUNNING", toStatus: "QUEUED", detail: { reason: "automatic_retry", attempt: job.attempts, maxAttempts: job.maxAttempts, nextAttemptDelayMs: delayMs } },
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
  }

  private async transitionTerminal(
    backgroundJobId: string,
    status: "COMPLETED" | "FAILED" | "TIMED_OUT",
    fields: { errorCode?: string; errorMessageSafe?: string; resultMetadata?: object | null; cancelledAt?: Date; deadLettered?: boolean } = {},
  ): Promise<void> {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      // Guarded the same way as scheduleRetry: only a row still RUNNING
      // may be moved to a terminal status by this execution.
      const result = await tx.backgroundJob.updateMany({
        where: { id: backgroundJobId, status: "RUNNING" },
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

  private getQueue(queueName: string): Queue {
    if (!this.connection) {
      throw new Error("BullMqWorkerManager.getQueue() called before onApplicationBootstrap");
    }
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  async onApplicationShutdown(): Promise<void> {
    // Worker.close() is cooperative — it stops accepting new jobs and
    // waits for in-flight jobs to finish (or their own timeout) before
    // resolving. This is the "graceful shutdown drains in-flight jobs"
    // requirement; hard process termination is out of scope by design
    // (see ProcessorManifest.cancelable's own doc comment).
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.connection?.quit();
  }
}
