import { randomUUID, createHash } from "crypto";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { boundedShutdown, type QueueRegistry, type ShutdownOutcomeTracker } from "@myev/shared";
import { Prisma, type BackgroundJob } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { AppConfig } from "../../config/configuration";
import { QUEUE_REGISTRY } from "./queue-registry.module";
import { SHUTDOWN_TRACKER } from "../../shutdown/shutdown.module";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * DEFECT-1F-003: idempotency uniqueness is enforced by two separate
 * PARTIAL unique indexes (see schema.prisma's BackgroundJob model
 * comment), not one composite constraint — a workspace-scoped violation
 * and a platform-level (workspaceId IS NULL) violation report distinct
 * `error.meta.target` column sets (verified empirically against a live
 * Postgres instance, not assumed): `["workspace_id", "idempotency_key"]`
 * for the former, `["idempotency_key"]` alone for the latter — Postgres
 * never includes a column that was NULL in the violating row's own key
 * in its error DETAIL, which is exactly what Prisma's `target` reflects.
 * Matching is exact (target's column set must equal the expected set for
 * the request's own scope, no more, no fewer) — a P2002 against some
 * other, unrelated constraint (e.g. publicId) must never be
 * misinterpreted as an idempotency conflict and silently swallowed.
 */
function isExpectedIdempotencyViolation(
  error: unknown,
  workspaceId: string | null,
): boolean {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== UNIQUE_CONSTRAINT_VIOLATION
  ) {
    return false;
  }
  const target = error.meta?.target;
  const targets = Array.isArray(target)
    ? target
    : typeof target === "string"
      ? [target]
      : [];
  const expected =
    workspaceId === null
      ? ["idempotency_key"]
      : ["workspace_id", "idempotency_key"];
  return (
    targets.length === expected.length &&
    expected.every((column) => targets.includes(column))
  );
}

// Deterministic regardless of key insertion order, so two logically-
// identical payloads submitted with differently-ordered object keys
// still fingerprint identically — a naive JSON.stringify would not
// guarantee that.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Identifies "is this the same logical enqueue request" for idempotency
 * purposes — never logged or echoed back to a caller (a hash, not the
 * payload itself), so a mismatch can be reported without leaking either
 * side's actual content.
 */
function computeFingerprint(jobType: string, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize({ jobType, payload })))
    .digest("hex");
}

const IDEMPOTENCY_CACHE_TTL_SECONDS = 86_400; // 24h — Module 1F Engineering Plan §7's API-level response-replay window.

interface IdempotencyCacheEntry {
  fingerprint: string;
  jobId: string;
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
 *
 * Idempotency (Milestone 6) is two layers, per the Engineering Plan:
 * queue-level (two PARTIAL unique indexes on background_jobs — see
 * isExpectedIdempotencyViolation's doc comment and schema.prisma's
 * BackgroundJob model, DEFECT-1F-003 — always authoritative,
 * Postgres-enforced, correct even if Redis is down or a prior BullMQ
 * entry has long since been
 * cleaned up by removeOnComplete/removeOnFail) and API-level (a Redis-
 * backed 24h response-replay cache in front of it — a fail-open
 * optimization, never itself a source of truth, so a Redis outage
 * degrades to "always fall through to Postgres," never to "dedup stops
 * working"). Both layers additionally verify the request's fingerprint
 * (jobType + canonicalized payload) matches the original — a same-key,
 * different-payload resubmission is a deterministic 409, never a silent
 * replay of the wrong result and never a second logical job.
 */
@Injectable()
export class BackgroundJobsService implements OnModuleDestroy {
  private readonly logger = new Logger(BackgroundJobsService.name);
  private redisConnection?: Redis;
  private readonly queues = new Map<string, Queue>();
  // Deliberately a SEPARATE connection from redisConnection (BullMQ's,
  // configured with maxRetriesPerRequest: null so commands queue forever
  // while offline — exactly wrong for a cache that must fail open
  // quickly). Mirrors WorkspaceCacheService's own fail-open pattern
  // (Module 1C): lazyConnect + maxRetriesPerRequest: 1 + no reconnect
  // backoff, so a GET/SET fails fast on a Redis outage instead of hanging.
  private idempotencyRedis?: Redis;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
    @Inject(SHUTDOWN_TRACKER) private readonly shutdownTracker: ShutdownOutcomeTracker,
  ) {}

  async enqueue(input: EnqueueJobInput): Promise<BackgroundJob> {
    const manifest = this.registry.getManifest(input.jobType);
    if (!manifest) {
      throw new BadRequestException({
        code: "JOB_TYPE_UNKNOWN",
        message: `"${input.jobType}" is not a registered job type.`,
      });
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

    // Computed once, after validation, and reused for BOTH idempotency
    // layers below — always over the validated/transformed payload, never
    // the raw input, so the API-level cache check and the DB-level
    // conflict check compare apples to apples.
    const fingerprint = computeFingerprint(input.jobType, payload);

    if (input.idempotencyKey) {
      const cached = await this.checkIdempotencyCache(
        input.workspaceId,
        input.idempotencyKey,
      );
      if (cached) {
        if (cached.fingerprint !== fingerprint) {
          throw new ConflictException({
            code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
            message:
              "This idempotency key was already used with a different job type or payload.",
          });
        }
        const cachedRow = await this.prisma.backgroundJob.findUnique({
          where: { id: cached.jobId },
        });
        // A cache hit pointing at a row that no longer exists shouldn't
        // happen in practice (the cache's 24h TTL is far shorter than the
        // 90-day background_jobs retention it points into) — if it ever
        // does, fall through to the normal path below rather than error.
        if (cachedRow) return cachedRow;
      }
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
        await tx.backgroundJobHistory.create({
          data: { backgroundJobId: created.id, toStatus: "QUEUED" },
        });
        return created;
      });
    } catch (error) {
      // Queue-level idempotency (Module 1F Engineering Plan §7): the
      // authoritative dedup is this Postgres unique constraint, not
      // BullMQ jobId alone — correct even if the API-level cache above
      // missed (a cold cache, a Redis outage, or simply outside its 24h
      // window) or the original dispatch's BullMQ entry has long since
      // been cleaned up by removeOnComplete/removeOnFail. A replay of the
      // same (workspaceId, idempotencyKey) pair returns the ORIGINAL row
      // rather than erroring or double-enqueuing — UNLESS the fingerprint
      // doesn't match, which is a genuinely different request reusing the
      // same key and must be a deterministic conflict, not a silent
      // replay of someone else's result. The lookup MUST run outside the
      // failed transaction: Postgres aborts the entire transaction on the
      // first error and refuses any further command in it (25P02) —
      // recovery can only happen in a fresh query after the rollback
      // completes.
      //
      // isExpectedIdempotencyViolation's error.meta.target check is
      // defense-in-depth, not the actual correctness guarantee — that
      // guarantee is the findFirst lookup immediately below. If the
      // target check ever mismatches against a future Prisma/Postgres
      // version's error metadata shape (true when it shouldn't be, or
      // false when it should), the lookup either won't run or will run
      // and find nothing, and `if (!existing) throw error` immediately
      // below rethrows the original, unmodified error either way. An
      // unexpected metadata format can therefore never silently produce
      // an incorrect idempotent replay — it can only, at worst, fail to
      // recognize a real conflict and surface the raw Prisma error
      // instead, which is a loud failure, not a silent one.
      const existing =
        input.idempotencyKey &&
        isExpectedIdempotencyViolation(error, input.workspaceId)
          ? await this.prisma.backgroundJob.findFirst({
              where: {
                workspaceId: input.workspaceId,
                idempotencyKey: input.idempotencyKey,
              },
            })
          : null;
      if (!existing) throw error;
      const existingFingerprint = computeFingerprint(
        existing.jobType,
        existing.payloadMetadata,
      );
      if (existingFingerprint !== fingerprint) {
        throw new ConflictException({
          code: "IDEMPOTENCY_KEY_PAYLOAD_MISMATCH",
          message:
            "This idempotency key was already used with a different job type or payload.",
        });
      }
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
      this.logger.error(
        { err: error, jobId: row.publicId, jobType: input.jobType },
        "failed to dispatch job to BullMQ after Postgres commit",
      );
      await this.prisma.backgroundJob
        .update({
          where: { id: row.id },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            errorCode: "ENQUEUE_DISPATCH_FAILED",
            errorMessageSafe: "Failed to dispatch job to the queue.",
          },
        })
        .catch(() => undefined);
      throw error;
    }

    if (input.idempotencyKey) {
      await this.cacheIdempotencyResult(
        input.workspaceId,
        input.idempotencyKey,
        fingerprint,
        row.id,
      );
    }

    return row;
  }

  async list(
    workspaceId: string,
    filters: { status?: string; jobType?: string; limit: number },
  ): Promise<BackgroundJob[]> {
    return this.prisma.backgroundJob.findMany({
      where: {
        workspaceId,
        status: filters.status as never,
        jobType: filters.jobType,
      },
      orderBy: { createdAt: "desc" },
      take: filters.limit,
    });
  }

  async get(workspaceId: string, jobPublicId: string): Promise<BackgroundJob> {
    const job = await this.prisma.backgroundJob.findFirst({
      where: { publicId: jobPublicId, workspaceId },
    });
    if (!job) {
      throw new NotFoundException({
        code: "JOB_NOT_FOUND",
        message: "Background job not found.",
      });
    }
    return job;
  }

  async requestCancel(
    workspaceId: string,
    jobPublicId: string,
    actorUserId: string,
    ipAddress?: string,
  ): Promise<BackgroundJob> {
    const job = await this.get(workspaceId, jobPublicId);

    if ((TERMINAL_STATUSES as readonly string[]).includes(job.status)) {
      throw new ConflictException({
        code: "JOB_ALREADY_TERMINAL",
        message: "This job has already finished and cannot be cancelled.",
      });
    }

    const manifest = this.registry.getManifest(job.jobType);
    if (!manifest?.cancelable) {
      throw new ConflictException({
        code: "JOB_TYPE_NOT_CANCELABLE",
        message: "This job type does not support cancellation.",
      });
    }

    if (job.cancellationRequestedAt) {
      // Idempotent: repeated cancel requests on an already-requested job
      // are a no-op, not an error and not a duplicate audit entry.
      return job;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.backgroundJob.updateMany({
        where: { id: job.id, cancellationRequestedAt: null },
        data: { cancellationRequestedAt: new Date() },
      });
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

  async requestRetry(
    workspaceId: string,
    jobPublicId: string,
    actorUserId: string,
    ipAddress?: string,
  ): Promise<BackgroundJob> {
    const job = await this.get(workspaceId, jobPublicId);

    const manifest = this.registry.getManifest(job.jobType);
    if (!manifest?.supportsRetry) {
      throw new ConflictException({
        code: "JOB_TYPE_NOT_RETRYABLE",
        message: "This job type does not support retry.",
      });
    }

    if (job.status !== "FAILED" && job.status !== "TIMED_OUT") {
      throw new ConflictException({
        code: "JOB_NOT_RETRYABLE_IN_CURRENT_STATE",
        message: "Only a failed or timed-out job can be retried.",
      });
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
      await tx.backgroundJobHistory.create({
        data: {
          backgroundJobId: job.id,
          fromStatus: job.status,
          toStatus: "QUEUED",
          detail: { reason: "manual_retry" },
        },
      });
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
        message:
          "This job's retry has already been scheduled by another request.",
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
    try {
      await queue.add(job.jobType, job.payloadMetadata as object, {
        jobId: job.id,
        attempts: 1,
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      });
    } catch (dispatchError) {
      // Same compensating pattern as the Worker's own automatic
      // scheduleRetry (see its comment): the guarded Postgres write above
      // already committed the row to QUEUED, so a synchronous dispatch
      // failure here would otherwise leave it silently stuck — healthy-
      // looking, but with no BullMQ entry that will ever pick it up.
      // Compensate to a visible terminal state instead of leaving that gap.
      this.logger.error(
        { err: dispatchError, jobId: job.publicId },
        "retry dispatch failed after the Postgres retry-scheduling commit — compensating to dead-lettered",
      );
      await this.prisma.backgroundJob
        .updateMany({
          where: { id: job.id, status: "QUEUED" },
          data: {
            status: "FAILED",
            failedAt: new Date(),
            deadLetteredAt: new Date(),
            errorCode: "RETRY_DISPATCH_FAILED",
            errorMessageSafe: "Failed to dispatch the retry to the queue.",
          },
        })
        .catch(() => undefined);
      throw new HttpException(
        {
          code: "RETRY_DISPATCH_FAILED",
          message: "Failed to dispatch the retry to the queue.",
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return this.get(workspaceId, jobPublicId);
  }

  private getQueue(queueName: string): Queue {
    if (!this.redisConnection) {
      this.redisConnection = new Redis(
        this.config.get("redisUrl", { infer: true }),
        { maxRetriesPerRequest: null },
      );
      // Same rationale as apps/worker's BullMqWorkerManager: an unhandled
      // 'error' event on a bare Node EventEmitter crashes the process —
      // without this, a transient Redis blip would take down the whole
      // API process instead of letting ioredis's own automatic reconnect
      // recover in place.
      this.redisConnection.on("error", (error) => {
        this.logger.error({ err: error }, "Redis connection error");
      });
    }
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.redisConnection });
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  private getIdempotencyRedis(): Redis {
    if (!this.idempotencyRedis) {
      this.idempotencyRedis = new Redis(
        this.config.get("redisUrl", { infer: true }),
        {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: () => null,
        },
      );
      this.idempotencyRedis.on("error", () => {
        // Swallow — every call site below already treats a Redis error as
        // a cache miss / no-op and logs its own warning with call-site
        // context; nothing else to react to here (mirrors
        // WorkspaceCacheService's identical rationale).
      });
    }
    return this.idempotencyRedis;
  }

  private idempotencyCacheKey(
    workspaceId: string | null,
    idempotencyKey: string,
  ): string {
    return `bg-job-idem:${workspaceId ?? "platform"}:${idempotencyKey}`;
  }

  private async checkIdempotencyCache(
    workspaceId: string | null,
    idempotencyKey: string,
  ): Promise<IdempotencyCacheEntry | null> {
    try {
      const raw = await this.getIdempotencyRedis().get(
        this.idempotencyCacheKey(workspaceId, idempotencyKey),
      );
      return raw ? (JSON.parse(raw) as IdempotencyCacheEntry) : null;
    } catch (error) {
      // Fail OPEN: a Redis outage here degrades to "always fall through
      // to the Postgres-level check below," never to "dedup breaks" — the
      // unique constraint remains authoritative regardless. Never logs
      // the idempotency key or any payload — just that a read failed.
      this.logger.warn(
        { err: error },
        "idempotency cache read failed — failing open, Postgres unique constraint remains authoritative",
      );
      return null;
    }
  }

  private async cacheIdempotencyResult(
    workspaceId: string | null,
    idempotencyKey: string,
    fingerprint: string,
    jobId: string,
  ): Promise<void> {
    try {
      await this.getIdempotencyRedis().set(
        this.idempotencyCacheKey(workspaceId, idempotencyKey),
        JSON.stringify({ fingerprint, jobId } satisfies IdempotencyCacheEntry),
        "EX",
        IDEMPOTENCY_CACHE_TTL_SECONDS,
      );
    } catch (error) {
      // Best-effort only — a failed cache write never fails the enqueue
      // that already succeeded; the next replay attempt just falls
      // through to the (slower, but authoritative) Postgres path.
      this.logger.warn(
        { err: error },
        "idempotency cache write failed — best-effort only, enqueue already succeeded",
      );
    }
  }

  /**
   * DEFECT-1F-001: Queue.close()/redisConnection.quit() are unbounded —
   * bounded via @myev/shared's boundedShutdown, mirroring
   * BullMqWorkerManager's identical fix in apps/worker (see that class's
   * onApplicationShutdown doc comment for the full rationale). This
   * process never runs a BullMQ Worker (it only enqueues, never
   * executes), so there is no BullMQ-internal blocking connection to
   * force-close here — redisConnection.disconnect() is the complete
   * force story for this component. idempotencyRedis's own cleanup is
   * untouched — it is already correctly bounded (lazyConnect,
   * maxRetriesPerRequest: 1, retryStrategy: () => null, plain
   * .disconnect() on shutdown) and was never part of this defect.
   */
  async onModuleDestroy(): Promise<void> {
    const deadlineMs = this.config.get("redisShutdownDeadlineMs", { infer: true });

    const outcome = await boundedShutdown(
      async () => {
        await Promise.all([...this.queues.values()].map((queue) => queue.close()));
        await this.redisConnection?.quit();
      },
      () => {
        this.redisConnection?.disconnect();
      },
      deadlineMs,
    );

    this.shutdownTracker.record(BackgroundJobsService.name, outcome);
    if (outcome !== "GRACEFUL") {
      const level = outcome === "FAILED" ? "error" : "warn";
      this.logger[level](
        { event: outcome === "FAILED" ? "REDIS_SHUTDOWN_FAILED" : "REDIS_SHUTDOWN_FORCED", component: BackgroundJobsService.name, deadlineMs },
        outcome === "FAILED" ? "shutdown force-close also failed" : "graceful shutdown exceeded the deadline — forced disconnect",
      );
    }

    this.idempotencyRedis?.disconnect();
  }
}
