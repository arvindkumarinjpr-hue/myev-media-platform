import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Job, Worker } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { JobCancelledError, type ProcessorContext, type QueueRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { QUEUE_REGISTRY } from "../queue/queue-registry.module";
import { WorkerHeartbeatService } from "../heartbeat/worker-heartbeat.service";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "../../../api/generated/prisma";

class ProcessorTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`processor exceeded its configured timeout of ${timeoutMs}ms`);
    this.name = "ProcessorTimeoutError";
  }
}

/**
 * Owns one BullMQ Worker per queue this process is assigned to
 * (config.queues). Dispatches a job to its ProcessorManifest's bound
 * handler and owns the background_jobs row's execution-side lifecycle —
 * the API's enqueue/cancel/retry endpoints (Module 1F Milestone 4's other
 * half) own the creation/cancellation-request/retry-request side. The two
 * never write the same fields: this class only ever transitions
 * QUEUED -> RUNNING -> a terminal status.
 *
 * A BullMQ job's `id` IS the background_jobs row's internal `id` (set at
 * enqueue time) — that identity is what lets this process correlate a
 * dequeued job back to its authoritative Postgres row without carrying
 * any extra metadata through job.data, which stays exactly the manifest's
 * payload shape.
 */
@Injectable()
export class BullMqWorkerManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection?: Redis;
  private readonly workers: Worker[] = [];

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
    const backgroundJobId = String(job.id);

    // Transition QUEUED -> RUNNING, guarded on the row still being QUEUED —
    // protects against a redelivered/duplicate BullMQ delivery re-running
    // an already-picked-up job. A guard miss is a benign no-op, not an
    // error: whoever delivered this duplicate already has a real outcome
    // recorded from the delivery that won the race.
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
      this.logger.error(logContext, `no ProcessorManifest/handler bound for job type "${jobType}"`);
      await this.markTerminal(backgroundJobId, "FAILED", { errorCode: "UNKNOWN_JOB_TYPE", errorMessageSafe: "No processor is registered for this job type." });
      throw new Error(`no ProcessorManifest/handler bound for job type "${jobType}"`);
    }

    const payload = plainToInstance(manifest.payloadDto, job.data);
    const validationErrors = await validate(payload);
    if (validationErrors.length > 0) {
      this.logger.error({ ...logContext, validationErrors }, "job payload failed validation");
      await this.markTerminal(backgroundJobId, "FAILED", { errorCode: "PAYLOAD_VALIDATION_FAILED", errorMessageSafe: "Job payload failed validation." });
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
      await this.markTerminal(backgroundJobId, "COMPLETED", { resultMetadata: safeResult });
      this.logger.info(logContext, "job execution completed");
      return result;
    } catch (error) {
      clearTimeout(timer);

      if (error instanceof ProcessorTimeoutError) {
        this.logger.error({ ...logContext, err: error }, "job execution timed out");
        await this.markTerminal(backgroundJobId, "TIMED_OUT", { errorCode: "PROCESSOR_TIMEOUT", errorMessageSafe: "Job execution exceeded its configured timeout." });
        throw error;
      }

      if (error instanceof JobCancelledError) {
        this.logger.info({ ...logContext, err: error }, "job execution cancelled");
        await this.markTerminal(backgroundJobId, "FAILED", {
          errorCode: "JOB_CANCELLED_BY_USER",
          errorMessageSafe: "Job was cancelled.",
          cancelledAt: new Date(),
        });
        throw error;
      }

      this.logger.error({ ...logContext, err: error }, "job execution failed");
      await this.markTerminal(backgroundJobId, "FAILED", { errorCode: "PROCESSOR_ERROR", errorMessageSafe: "Job execution failed." });
      throw error;
    }
  }

  private async markTerminal(
    backgroundJobId: string,
    status: "COMPLETED" | "FAILED" | "TIMED_OUT",
    fields: { errorCode?: string; errorMessageSafe?: string; resultMetadata?: object | null; cancelledAt?: Date },
  ): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.backgroundJob.update({
        where: { id: backgroundJobId },
        data: {
          status,
          completedAt: status === "COMPLETED" ? now : undefined,
          failedAt: status !== "COMPLETED" ? now : undefined,
          errorCode: fields.errorCode,
          errorMessageSafe: fields.errorMessageSafe,
          resultMetadata: fields.resultMetadata === null ? Prisma.JsonNull : fields.resultMetadata,
          cancelledAt: fields.cancelledAt,
        },
      });
      await tx.backgroundJobHistory.create({
        data: { backgroundJobId, fromStatus: "RUNNING", toStatus: status, detail: fields.errorCode ? { errorCode: fields.errorCode } : undefined },
      });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // Worker.close() is cooperative — it stops accepting new jobs and
    // waits for in-flight jobs to finish (or their own timeout) before
    // resolving. This is the "graceful shutdown drains in-flight jobs"
    // requirement; hard process termination is out of scope by design
    // (see ProcessorManifest.cancelable's own doc comment).
    await Promise.all(this.workers.map((worker) => worker.close()));
    await this.connection?.quit();
  }
}
