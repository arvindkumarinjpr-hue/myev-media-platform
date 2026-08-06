import { randomUUID } from "crypto";
import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Queue } from "bullmq";
import Redis from "ioredis";
import type { QueueRegistry } from "@myev/shared";
import { Prisma, type BackgroundJob } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AppConfig } from "../../config/configuration";
import { QUEUE_REGISTRY } from "./queue-registry.module";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

function isExpectedUniqueViolation(error: unknown, columnSubstrings: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_CONSTRAINT_VIOLATION) {
    return false;
  }
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return columnSubstrings.every((needle) => targets.some((entry) => typeof entry === "string" && entry.toLowerCase().includes(needle.toLowerCase())));
}

export interface EnqueueJobInput {
  workspaceId: string | null;
  jobType: string;
  payload: object;
  createdByUserId?: string | null;
  idempotencyKey?: string;
  correlationId?: string;
  parentJobId?: string;
}

const TERMINAL_STATUSES = ["COMPLETED", "FAILED", "TIMED_OUT"] as const;

/**
 * The API-process half of Module 1F's job lifecycle: creation
 * (`enqueue`), introspection (`list`/`get`), and user-initiated
 * transitions (`requestCancel`/`requestRetry`). Never writes the fields
 * the Worker owns (status RUNNING/COMPLETED/FAILED/TIMED_OUT,
 * startedAt/completedAt/failedAt, attempts, processorVersion,
 * resultMetadata) — see apps/worker/src/bullmq/bullmq-worker.manager.ts
 * for that half, including its own automatic retry/backoff/dead-letter
 * scheduling (Milestone 5) and the "exactly one component schedules a
 * retry" invariant documented there. `requestRetry()` here is the other,
 * user-triggered half of that same invariant: it only ever acts on a row
 * already in a terminal status, which the Worker's own automatic
 * scheduling never leaves ambiguous (see that class's doc comment) — and
 * every write on this side is additionally a guarded conditional UPDATE,
 * so a violation of that reasoning fails deterministically rather than
 * double-dispatching.
 *
 * `enqueue()` has no public HTTP endpoint in Module 1F (no business job
 * exists yet to trigger one) — it is internal plumbing a future module's
 * own service calls directly once it has a real job type to dispatch.
 */
@Injectable()
export class BackgroundJobsService implements OnModuleDestroy {
  private readonly logger = new Logger(BackgroundJobsService.name);
  private redisConnection?: Redis;
  private readonly queues = new Map<string, Queue>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
  ) {}

  async enqueue(input: EnqueueJobInput): Promise<BackgroundJob> {
    const manifest = this.registry.getManifest(input.jobType);
    if (!manifest) {
      throw new BadRequestException({ code: "JOB_TYPE_UNKNOWN", message: `"${input.jobType}" is not a registered job type.` });
    }

    const payload = plainToInstance(manifest.payloadDto, input.payload);
    const validationErrors = await validate(payload);
    if (validationErrors.length > 0) {
      throw new BadRequestException({
        code: "JOB_PAYLOAD_INVALID",
        message: "Job payload failed validation.",
        details: validationErrors.map((error) => error.toString()),
      });
    }

    const correlationId = input.correlationId ?? randomUUID();

    let row: BackgroundJob;
    let replay = false;
    try {
      row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.backgroundJob.create({
          data: {
            workspaceId: input.workspaceId,
            jobType: input.jobType,
            queueName: manifest.queue,
            payloadMetadata: payload as unknown as Prisma.InputJsonValue,
            maxAttempts: manifest.defaultRetryPolicy?.maxAttempts ?? 1,
            idempotencyKey: input.idempotencyKey,
            correlationId,
            parentJobId: input.parentJobId,
            createdById: input.createdByUserId,
          },
        });
        await tx.backgroundJobHistory.create({ data: { backgroundJobId: created.id, toStatus: "QUEUED" } });
        return created;
      });
    } catch (error) {
      // Queue-level idempotency (Module 1F Engineering Plan §7): the
      // authoritative dedup is this Postgres unique constraint, not
      // BullMQ jobId alone. A replay of the same (workspaceId,
      // idempotencyKey) pair returns the ORIGINAL row rather than
      // erroring or double-enqueuing. Full API-level Idempotency-Key
      // response replay is Milestone 6's scope — this is the queue-level
      // half only. The lookup MUST run outside the failed transaction:
      // Postgres aborts the entire transaction on the first error and
      // refuses any further command in it (25P02) — recovery can only
      // happen in a fresh query after the rollback completes.
      const existing =
        input.idempotencyKey && isExpectedUniqueViolation(error, ["workspace_id", "idempotency_key"])
          ? await this.prisma.backgroundJob.findFirst({ where: { workspaceId: input.workspaceId, idempotencyKey: input.idempotencyKey } })
          : null;
      if (!existing) throw error;
      row = existing;
      replay = true;
    }

    if (replay) return row;

    try {
      await this.getQueue(manifest.queue).add(input.jobType, payload, {
        jobId: row.id,
        attempts: 1,
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      });
    } catch (error) {
      // Known limitation, documented rather than silently ignored: this
      // is a best-effort compensation, not a full transactional-outbox
      // guarantee (that pattern is reserved for domain_events, Milestone
      // 8) — a crash between the Postgres commit above and this dispatch
      // would leave the row stuck QUEUED with no compensating update at
      // all. A future hardening pass should reconcile stuck QUEUED rows
      // against BullMQ, not invented speculatively here.
      this.logger.error({ err: error, jobId: row.publicId, jobType: input.jobType }, "failed to dispatch job to BullMQ after Postgres commit");
      await this.prisma.backgroundJob
        .update({ where: { id: row.id }, data: { status: "FAILED", failedAt: new Date(), errorCode: "ENQUEUE_DISPATCH_FAILED", errorMessageSafe: "Failed to dispatch job to the queue." } })
        .catch(() => undefined);
      throw error;
    }

    return row;
  }

  async list(workspaceId: string, filters: { status?: string; jobType?: string; limit: number }): Promise<BackgroundJob[]> {
    return this.prisma.backgroundJob.findMany({
      where: { workspaceId, status: filters.status as never, jobType: filters.jobType },
      orderBy: { createdAt: "desc" },
      take: filters.limit,
    });
  }

  async get(workspaceId: string, jobPublicId: string): Promise<BackgroundJob> {
    const job = await this.prisma.backgroundJob.findFirst({ where: { publicId: jobPublicId, workspaceId } });
    if (!job) {
      throw new NotFoundException({ code: "JOB_NOT_FOUND", message: "Background job not found." });
    }
    return job;
  }

  async requestCancel(workspaceId: string, jobPublicId: string, actorUserId: string, ipAddress?: string): Promise<BackgroundJob> {
    const job = await this.get(workspaceId, jobPublicId);

    if ((TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw new ConflictException({ code: "JOB_ALREADY_TERMINAL", message: "This job has already finished and cannot be cancelled." });
    }

    const manifest = this.registry.getManifest(job.jobType);
    if (!manifest?.cancelable) {
      throw new ConflictException({ code: "JOB_TYPE_NOT_CANCELABLE", message: "This job type does not support cancellation." });
    }

    if (job.cancellationRequestedAt) {
      // Idempotent: repeated cancel requests on an already-requested job
      // are a no-op, not an error and not a duplicate audit entry.
      return job;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.backgroundJob.updateMany({ where: { id: job.id, cancellationRequestedAt: null }, data: { cancellationRequestedAt: new Date() } });
      await this.audit.recordWithinTransaction(tx, {
        action: "JOB_CANCELLATION_REQUESTED",
        actorUserId,
        workspaceId,
        entityType: "background_job",
        entityId: job.publicId,
        ipAddress,
      });
    });

    return this.get(workspaceId, jobPublicId);
  }

  async requestRetry(workspaceId: string, jobPublicId: string, actorUserId: string, ipAddress?: string): Promise<BackgroundJob> {
    const job = await this.get(workspaceId, jobPublicId);

    const manifest = this.registry.getManifest(job.jobType);
    if (!manifest?.supportsRetry) {
      throw new ConflictException({ code: "JOB_TYPE_NOT_RETRYABLE", message: "This job type does not support retry." });
    }

    if (job.status !== "FAILED" && job.status !== "TIMED_OUT") {
      throw new ConflictException({ code: "JOB_NOT_RETRYABLE_IN_CURRENT_STATE", message: "Only a failed or timed-out job can be retried." });
    }

    // Exactly-one-scheduler invariant: the read above and this write are
    // not atomic — two concurrent retry requests (a double-click, or a
    // race with whatever else might touch this row) could both pass the
    // status check above before either commits. The WHERE clause here is
    // the real guard: only a row still in a retryable status at WRITE
    // time is affected, and Postgres serializes the two UPDATEs, so
    // exactly one of two racing callers ever sees count===1. The loser
    // fails deterministically instead of silently also dispatching a
    // second, duplicate execution.
    const scheduled = await this.prisma.$transaction(async (tx) => {
      const result = await tx.backgroundJob.updateMany({
        where: { id: job.id, status: { in: ["FAILED", "TIMED_OUT"] } },
        data: {
          status: "QUEUED",
          startedAt: null,
          completedAt: null,
          failedAt: null,
          cancellationRequestedAt: null,
          cancelledAt: null,
          deadLetteredAt: null,
          errorCode: null,
          errorMessageSafe: null,
          resultMetadata: Prisma.JsonNull,
        },
      });
      if (result.count === 0) return false;
      await tx.backgroundJobHistory.create({ data: { backgroundJobId: job.id, fromStatus: job.status, toStatus: "QUEUED", detail: { reason: "manual_retry" } } });
      await this.audit.recordWithinTransaction(tx, {
        action: "JOB_RETRY_REQUESTED",
        actorUserId,
        workspaceId,
        entityType: "background_job",
        entityId: job.publicId,
        ipAddress,
      });
      return true;
    });

    if (!scheduled) {
      throw new ConflictException({
        code: "JOB_RETRY_ALREADY_SCHEDULED",
        message: "This job's retry has already been scheduled by another request.",
      });
    }

    // A manual retry is a fresh, immediate re-attempt — no backoff delay
    // (that belongs to the Worker's own automatic transient-failure
    // retry). The same background_jobs.id is reused as BullMQ's jobId
    // (see apps/worker's correlation mechanism), so the prior dispatch's
    // completed/failed BullMQ entry must be removed first or the re-add
    // would collide. This dispatch only ever runs after the guarded
    // Postgres write above has already succeeded, so it can never itself
    // run twice for the same execution either.
    const queue = this.getQueue(job.queueName);
    await queue.remove(job.id).catch(() => undefined);
    await queue.add(job.jobType, job.payloadMetadata as object, {
      jobId: job.id,
      attempts: 1,
      removeOnComplete: { age: 3_600 },
      removeOnFail: { age: 86_400 },
    });

    return this.get(workspaceId, jobPublicId);
  }

  private getQueue(queueName: string): Queue {
    this.redisConnection ??= new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.redisConnection });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.redisConnection?.quit();
  }
}
