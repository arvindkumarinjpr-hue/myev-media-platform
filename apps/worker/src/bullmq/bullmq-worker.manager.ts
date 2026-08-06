import { randomUUID } from "crypto";
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Job, Worker } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import type { ProcessorContext, QueueRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { QUEUE_REGISTRY } from "../queue/queue-registry.module";
import { WorkerHeartbeatService } from "../heartbeat/worker-heartbeat.service";

/**
 * Owns one BullMQ Worker per queue this process is assigned to
 * (config.queues). Deliberately thin for Module 1F Milestone 3: it
 * dispatches a completed job to the ProcessorManifest's bound handler and
 * validates the payload/result shape, but does NOT yet read or write a
 * background_jobs row — that persistence-layer job lifecycle (shared
 * between the API's enqueue/cancel/retry endpoints and this Worker's
 * execution path) is Milestone 4's scope. isCancelled() is therefore a
 * safe "never cancelled" stub here — cancelable manifests exist, but
 * nothing can request cancellation yet without an API to do it from.
 */
@Injectable()
export class BullMqWorkerManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection?: Redis;
  private readonly workers: Worker[] = [];

  constructor(
    private readonly config: ConfigService<WorkerConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    private readonly heartbeat: WorkerHeartbeatService,
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
    const manifest = this.registry.getManifest(jobType);
    const handler = this.registry.getHandler(jobType);
    const correlationId = (job.data as { correlationId?: string })?.correlationId ?? randomUUID();
    const logContext = {
      jobId: job.id,
      correlationId,
      workerId: this.heartbeat.workerId,
      queueName,
      jobType,
      processorVersion,
      attempt: job.attemptsMade + 1,
    };

    if (!manifest || !handler) {
      // Structurally unreachable given this worker's own bootstrap
      // validation (every queue it opens has a bound handler for every
      // manifest in scope) — reachable only if something outside this
      // process enqueues a job.name this worker's registry never declared.
      this.logger.error(logContext, `no ProcessorManifest/handler bound for job type "${jobType}"`);
      throw new Error(`no ProcessorManifest/handler bound for job type "${jobType}"`);
    }

    const payload = plainToInstance(manifest.payloadDto, job.data);
    const validationErrors = await validate(payload);
    if (validationErrors.length > 0) {
      this.logger.error({ ...logContext, validationErrors }, "job payload failed validation");
      throw new Error(`job payload for "${jobType}" failed validation: ${validationErrors.map((e) => e.toString()).join("; ")}`);
    }

    const context: ProcessorContext = {
      jobId: String(job.id),
      correlationId,
      attempt: job.attemptsMade + 1,
      // Milestone 4 replaces this with a real check against
      // background_jobs.cancellation_requested_at once enqueued jobs
      // have a persisted row to check.
      isCancelled: async () => false,
    };

    this.logger.info(logContext, "job execution started");
    try {
      const result = await handler(payload, context);
      this.logger.info(logContext, "job execution completed");
      return result;
    } catch (error) {
      this.logger.error({ ...logContext, err: error }, "job execution failed");
      throw error;
    }
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
