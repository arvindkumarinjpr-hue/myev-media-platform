import { randomUUID } from "crypto";
import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { Queue, Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { boundedShutdown, type EventConsumerManifest, type EventRegistry, type ShutdownOutcomeTracker } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { EVENT_REGISTRY } from "./events.module";
import { WorkerHeartbeatService } from "../heartbeat/worker-heartbeat.service";
import { PrismaService } from "../prisma/prisma.service";
import { SHUTDOWN_TRACKER } from "../shutdown/shutdown.module";
import { Prisma } from "../../../api/generated/prisma";
import { isExpectedIdempotencyViolation } from "../scheduler/idempotency-violation";

// Deliberately NOT one of the 9 QueueName categories, and never
// registered as a ProcessorManifest — identical reasoning to
// SchedulerTickManager's own SCHEDULER_QUEUE_NAME: this is
// infrastructure, its own dedicated Worker consumes it, and
// BullMqWorkerManager's frozen pipeline is never involved.
const OUTBOX_RELAY_QUEUE_NAME = "OUTBOX_RELAY_INTERNAL";
const OUTBOX_RELAY_SCHEDULER_ID = "outbox-relay-primary";
const OUTBOX_RELAY_TICK_JOB_NAME = "outbox.relay.tick.v1";

// A lease is renewed once less than this fraction of its total duration
// remains — not on every single check. Internal tuning constant, not
// exposed as config: the review asked for OUTBOX_RELAY_CLAIM_LEASE_MS
// specifically, not a second renewal-cadence knob.
const RENEWAL_THRESHOLD_FRACTION = 0.5;

// Permanent — payload will never validate against this consumer no
// matter how many times it's reclaimed. Durably dead-lettered (Milestone
// 8.2 correctness fix item 6), never retried.
const PERMANENT_VALIDATION_ERROR_CODE = "EVENT_PAYLOAD_VALIDATION_FAILED";
// Transient — the same vocabulary BackgroundJobsService.enqueue() and
// SchedulerTickManager.dispatchOccurrence already use for "Postgres
// commit succeeded, the BullMQ .add() call itself failed." Retried by
// this relay's own reclaim loop (Milestone 8.2 correctness fix item 7).
const TRANSIENT_DISPATCH_ERROR_CODE = "ENQUEUE_DISPATCH_FAILED";

interface ClaimedDomainEvent {
  id: string;
  eventType: string;
  eventVersion: number;
  workspaceId: string | null;
  correlationId: string | null;
  causationId: string | null;
  payload: unknown;
  occurredAt: Date;
  // Mutable on purpose — renewClaim() extends claimExpiresAt in place so
  // every subsequent renewal check in the same processEvent() call sees
  // the up-to-date deadline without a redundant DB round-trip.
  claimToken: string;
  claimExpiresAt: Date;
}

type ConsumerDispatchOutcome = "dispatched" | "permanent-failure" | "transient-failure";

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Milestone 8.2 — the transactional outbox relay. Bridges DomainEvent
 * rows (Milestone 8.1's write side, EventPublisher) to the existing
 * BullMQ dispatch pipeline via BackgroundJob rows — mirroring
 * SchedulerTickManager's own "claim due work, dispatch via the same
 * row-then-BullMQ pattern every other job uses" shape, not a new
 * execution engine (ADR-005). No business handler logic lives here —
 * this class only ever decides WHICH events are due and creates the
 * BackgroundJob rows; whatever eventually executes them (Milestone 8.3)
 * is a separate concern.
 *
 * Claim / lease / finalize (Milestone 8.2 correctness fix). The
 * originally-shipped design used a read-only `SELECT ... FOR UPDATE SKIP
 * LOCKED` claim, reasoning that redundant reclaims were merely wasteful,
 * safely absorbed by downstream idempotency. That reasoning was reviewed
 * and empirically disproven: `FOR UPDATE SKIP LOCKED` only provides
 * mutual exclusion for the lifetime of the claiming transaction, which
 * the "no Redis/BullMQ network call while a Postgres row lock is held"
 * invariant forces to commit BEFORE dispatch even starts — so two
 * independent relay attempts (this instance's next tick if the first is
 * still mid-flight, or a second replica) can both legitimately claim and
 * both begin dispatching the same still-undispatched row. A persisted
 * lease closes that gap:
 *
 *   Transaction 1 (claimUndispatchedEvents): one atomic
 *     `UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)
 *     RETURNING ...` — claims a batch AND stamps claim_token/claimed_at/
 *     claim_expires_at in the same statement, so there is no window
 *     between "select the row" and "mark it claimed" for a second relay
 *     to slip into. Still a single Postgres statement, still commits
 *     immediately, still zero Redis/BullMQ calls under the lock.
 *   Unlocked: per-consumer dispatch, with the lease renewed (a second,
 *     independent, equally lock-free Postgres statement, guarded on
 *     claim_token) before fan-out starts, between each consumer, and
 *     again before finalization, whenever meaningful time has elapsed —
 *     see renewClaim()/maybeRenewClaim(). A renewal that affects zero
 *     rows means this relay no longer owns the event (either the lease
 *     already expired and someone else reclaimed it, or that's about to
 *     happen) — dispatch for that event stops immediately, and it is
 *     never finalized by this attempt.
 *   Transaction 2 (markDispatched): a guarded conditional UPDATE keyed on
 *     BOTH `dispatched_at IS NULL` AND `claim_token = $token` — a stale
 *     owner (lease expired, reclaimed by someone else) affects zero rows
 *     and never overwrites a newer claim's in-flight state. On success,
 *     the lease columns are cleared along with setting dispatched_at.
 *
 * A row whose claim_expires_at is in the past is exactly as eligible for
 * claim as a row that was never claimed at all (see claimUndispatchedEvents'
 * WHERE clause) — that equivalence IS the crash-recovery mechanism: a
 * relay that dies mid-dispatch simply leaves its claim to expire, and the
 * very next tick from any healthy relay reclaims it with a fresh token.
 * Redoing dispatch under a fresh claim stays safe because per-consumer
 * dispatch is independently idempotent at both the Postgres
 * (BackgroundJob.idempotencyKey, DEFECT-1F-003) and BullMQ (jobId reuse)
 * layers — idempotency remains defense-in-depth, not the sole ownership
 * mechanism, now that the lease exists.
 */
@Injectable()
export class OutboxRelayManager implements OnApplicationBootstrap, OnApplicationShutdown {
  private connection?: Redis;
  private tickQueue?: Queue;
  private tickWorker?: Worker;
  private readonly dispatchQueues = new Map<string, Queue>();
  private registrationRetryTimer?: NodeJS.Timeout;
  private shuttingDown = false;
  // Same rationale as SchedulerTickManager's identical field (DEFECT-
  // 1F-004): attemptRegistration is single-flight, so at most one of
  // these is ever set — exists solely so onApplicationShutdown can
  // force-disconnect an attempt that happens to be mid-flight.
  private inFlightRegistrationConnection?: Redis;

  constructor(
    private readonly config: ConfigService<WorkerConfig, true>,
    @Inject(EVENT_REGISTRY) private readonly eventRegistry: EventRegistry,
    private readonly heartbeat: WorkerHeartbeatService,
    private readonly prisma: PrismaService,
    @Inject(SHUTDOWN_TRACKER) private readonly shutdownTracker: ShutdownOutcomeTracker,
    @InjectPinoLogger(OutboxRelayManager.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Mirrors SchedulerTickManager's own bootstrap shape exactly (never
   * blocks application bootstrap on Redis reachability — the tick
   * Worker starts immediately, registration is bounded and retried in
   * the background) — a deliberately re-implemented, independent copy
   * of that proven pattern, not an extracted shared helper: touching
   * SchedulerTickManager's own already-defect-hardened (DEFECT-1F-004)
   * code to extract one would risk regressing it for no benefit this
   * milestone needs.
   */
  async onApplicationBootstrap(): Promise<void> {
    this.connection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    this.connection.on("error", (error) => {
      this.logger.error({ err: error }, "Redis connection error");
    });

    this.tickQueue = new Queue(OUTBOX_RELAY_QUEUE_NAME, { connection: this.connection });
    this.tickWorker = new Worker(OUTBOX_RELAY_QUEUE_NAME, (job) => this.handleTick(job), { connection: this.connection, concurrency: 1 });
    this.tickWorker.on("error", (error) => {
      this.logger.error({ err: error }, "outbox relay tick worker error");
    });

    const registered = await this.attemptRegistration();
    if (!registered) {
      this.scheduleRegistrationRetry();
    }
  }

  /** Reuses schedulerRegistrationTimeoutMs — the same generic "how long to wait for one upsertJobScheduler call" concern, not duplicated as new config. */
  private async attemptRegistration(): Promise<boolean> {
    const timeoutMs = this.config.get("schedulerRegistrationTimeoutMs", { infer: true });
    const tickIntervalMs = this.config.get("outboxRelayIntervalMs", { infer: true });

    const registrationConnection = new Redis(this.config.get("redisUrl", { infer: true }), { maxRetriesPerRequest: null });
    registrationConnection.on("error", () => undefined);
    const registrationQueue = new Queue(OUTBOX_RELAY_QUEUE_NAME, { connection: registrationConnection });
    this.inFlightRegistrationConnection = registrationConnection;

    try {
      const outcome = await Promise.race([
        registrationQueue
          .upsertJobScheduler(OUTBOX_RELAY_SCHEDULER_ID, { every: tickIntervalMs, tz: "UTC" }, { name: OUTBOX_RELAY_TICK_JOB_NAME, data: {} })
          .then(() => "registered" as const),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
      ]);
      if (outcome === "registered") {
        this.logger.info({ schedulerId: OUTBOX_RELAY_SCHEDULER_ID, tickIntervalMs }, "outbox relay tick registered");
        return true;
      }
      this.logger.error(
        { event: "OUTBOX_RELAY_REGISTRATION_FAILED", schedulerId: OUTBOX_RELAY_SCHEDULER_ID, timeoutMs },
        "outbox relay registration did not complete within the configured deadline",
      );
      return false;
    } catch (error) {
      this.logger.error(
        { event: "OUTBOX_RELAY_REGISTRATION_FAILED", schedulerId: OUTBOX_RELAY_SCHEDULER_ID, err: { message: safeMessage(error) } },
        "outbox relay registration attempt failed",
      );
      return false;
    } finally {
      // Same reasoning as SchedulerTickManager's identical finally block:
      // queue.close() never disconnects a caller-supplied connection
      // (BullMQ treats it as caller-owned) — the explicit, synchronous
      // disconnect() is what actually matters.
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
      this.logger.warn({ event: "OUTBOX_RELAY_REGISTRATION_RETRYING", schedulerId: OUTBOX_RELAY_SCHEDULER_ID }, "retrying outbox relay registration");
      this.attemptRegistration()
        .then((registered) => {
          if (registered) {
            this.logger.info({ event: "OUTBOX_RELAY_REGISTRATION_RECOVERED", schedulerId: OUTBOX_RELAY_SCHEDULER_ID }, "outbox relay registration recovered");
            return;
          }
          this.scheduleRegistrationRetry();
        })
        .catch((error: unknown) => {
          this.logger.error(
            { event: "OUTBOX_RELAY_REGISTRATION_FAILED", schedulerId: OUTBOX_RELAY_SCHEDULER_ID, err: { message: safeMessage(error) } },
            "outbox relay registration retry failed unexpectedly",
          );
          this.scheduleRegistrationRetry();
        });
    }, retryIntervalMs);
  }

  private async handleTick(_job: Job): Promise<void> {
    const correlationId = randomUUID();
    const workerId = this.heartbeat.workerId;
    const startedAt = Date.now();
    this.logger.info({ event: "OUTBOX_RELAY_TICK_STARTED", workerId, correlationId }, "outbox relay tick started");

    let claimedRows: ClaimedDomainEvent[] = [];
    let dispatchedEvents = 0;
    let consumerJobsCreated = 0;
    let skipped = 0;
    let ownershipLost = 0;
    let failed = 0;

    try {
      claimedRows = await this.claimUndispatchedEvents();

      for (const row of claimedRows) {
        try {
          const result = await this.processEvent(row, correlationId);
          consumerJobsCreated += result.consumerJobsCreated;
          if (result.dispatched) dispatchedEvents++;
          if (result.skipped) skipped++;
          if (result.ownershipLost) ownershipLost++;
        } catch (error) {
          // Per-row isolation (Milestone 8 Architecture §12/§25, mirrors
          // SchedulerTickManager's identical per-schedule isolation): one
          // bad event never aborts the rest of the batch. Never logs the
          // payload — only safe, identifying metadata.
          failed++;
          this.logger.error(
            {
              event: "OUTBOX_EVENT_DISPATCH_FAILED",
              domainEventId: row.id,
              eventType: row.eventType,
              workspaceId: row.workspaceId,
              correlationId,
              err: { message: safeMessage(error) },
            },
            "event dispatch failed",
          );
        }
      }

      this.logger.info(
        {
          event: "OUTBOX_RELAY_TICK_COMPLETED",
          workerId,
          correlationId,
          scanned: claimedRows.length,
          claimed: claimedRows.length,
          dispatchedEvents,
          consumerJobsCreated,
          skipped,
          ownershipLost,
          failed,
          durationMs: Date.now() - startedAt,
        },
        "outbox relay tick completed",
      );
    } catch (error) {
      this.logger.error(
        {
          event: "OUTBOX_RELAY_TICK_FAILED",
          workerId,
          correlationId,
          scanned: claimedRows.length,
          err: { message: safeMessage(error) },
          durationMs: Date.now() - startedAt,
        },
        "outbox relay tick failed",
      );
      // Not rethrown to BullMQ as a job failure needing retry — the next
      // tick, one interval away, is itself the retry mechanism (same
      // reasoning as SchedulerTickManager.handleTick).
    }
  }

  /**
   * Transaction 1 — claim AND lease in one atomic statement, no dispatch.
   * Commits (and releases the row locks) the moment this resolves, well
   * before any BullMQ call — see this class's own doc comment for the
   * full claim/lease/finalize rationale. Raw SQL: Prisma's schema DSL
   * cannot express "UPDATE ... WHERE id IN (SELECT ... FOR UPDATE SKIP
   * LOCKED)" — the standard, canonical Postgres competing-consumers idiom
   * — and the SELECT half must exactly match the shape the existing
   * hand-written partial index (domain_events_undispatched_idx) was built
   * for. Verified via EXPLAIN ANALYZE against a realistic-scale table
   * (500k+ rows, ~300 undispatched): the planner uses
   * domain_events_undispatched_idx for the inner candidate scan and
   * domain_events_pkey for the outer UPDATE's row match — no additional
   * index is justified by the actual query shape.
   */
  private async claimUndispatchedEvents(): Promise<ClaimedDomainEvent[]> {
    const batchSize = this.config.get("outboxRelayBatchSize", { infer: true });
    const leaseMs = this.config.get("outboxRelayClaimLeaseMs", { infer: true });
    const claimToken = randomUUID();

    return this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<ClaimedDomainEvent[]>`
        UPDATE domain_events
        SET claim_token = ${claimToken}::uuid,
            claimed_at = now(),
            claim_expires_at = now() + (${leaseMs}::int * interval '1 millisecond')
        WHERE id IN (
          SELECT id
          FROM domain_events
          WHERE dispatched_at IS NULL
            AND (claim_expires_at IS NULL OR claim_expires_at < now())
          ORDER BY occurred_at ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING
          id,
          event_type AS "eventType",
          event_version AS "eventVersion",
          workspace_id AS "workspaceId",
          correlation_id AS "correlationId",
          causation_id AS "causationId",
          payload,
          occurred_at AS "occurredAt",
          claim_token AS "claimToken",
          claim_expires_at AS "claimExpiresAt"
      `;
    });
  }

  /**
   * Extends this relay's lease on `row` if — and only if — meaningful
   * time has elapsed since it was last set (RENEWAL_THRESHOLD_FRACTION of
   * the full lease remaining or less), covering all three mandatory
   * renewal points from a single call site: before fan-out starts,
   * between each consumer, and before finalization. A no-op (returns
   * true without a DB call) when the current lease is still comfortably
   * fresh — this is a check-and-extend, not an unconditional renewal on
   * every call. Pure Postgres, no network call to Redis/BullMQ.
   *
   * Returns false — meaning "this relay no longer owns the event, stop
   * dispatching it now" — only when a renewal was actually attempted and
   * affected zero rows: the guard (`id = ... AND claim_token = ... AND
   * dispatched_at IS NULL`) failed, which can only happen if the lease
   * already expired and a different relay reclaimed it with a new token
   * (or, less commonly, the row was already finalized by someone else in
   * the same narrow window).
   */
  private async maybeRenewClaim(row: ClaimedDomainEvent, correlationId: string, leaseMs: number): Promise<boolean> {
    const remainingMs = row.claimExpiresAt.getTime() - Date.now();
    if (remainingMs > leaseMs * RENEWAL_THRESHOLD_FRACTION) {
      return true;
    }

    const newExpiry = new Date(Date.now() + leaseMs);
    const result = await this.prisma.domainEvent.updateMany({
      where: { id: row.id, claimToken: row.claimToken, dispatchedAt: null },
      data: { claimExpiresAt: newExpiry },
    });

    if (result.count === 0) {
      this.logger.warn(
        {
          event: "OUTBOX_EVENT_OWNERSHIP_LOST",
          domainEventId: row.id,
          eventType: row.eventType,
          workspaceId: row.workspaceId,
          correlationId,
        },
        "lease renewal found this relay no longer owns the claim — another relay has already reclaimed it; stopping further dispatch for this event",
      );
      return false;
    }

    row.claimExpiresAt = newExpiry;
    return true;
  }

  /**
   * Resolves consumers, fans out, and finalizes — entirely outside any
   * held Postgres lock (the claim transaction already committed by the
   * time this runs). Renews the lease before fan-out, between each
   * consumer, and before finalization (Milestone 8.2 correctness fix
   * item 3) — a fixed lease alone is insufficient for a batch whose
   * dispatch genuinely takes a while. Returns per-event accounting for
   * the tick summary.
   */
  private async processEvent(
    row: ClaimedDomainEvent,
    correlationId: string,
  ): Promise<{ dispatched: boolean; skipped: boolean; consumerJobsCreated: number; ownershipLost: boolean }> {
    const consumers = this.eventRegistry.getConsumersForEventType(row.eventType);

    if (consumers.length === 0) {
      // MILESTONE 8.1's own frozen Zero-Consumer Manifest Semantics
      // decision (Option A): an event with no registered consumer must
      // not be silently treated as successfully dispatched. Left
      // undispatched — never marked — so it stays visible via the
      // Undispatched Events metric (Milestone 8 Architecture §28) and
      // this per-tick `skipped` counter/warn log, not silently ignored.
      // Its lease is simply left to expire naturally (no early release
      // needed) — the very next reclaim after expiry re-evaluates and
      // reaches this same, correct, terminal-in-practice conclusion
      // again, at negligible cost.
      //
      // The identical reasoning applies to an eventType whose version
      // suffix has no registered consumer (e.g. a producer emits
      // "content.published.v3" but only a "...v2" consumer exists) —
      // getConsumersForEventType matches the exact eventType string, so
      // an unsupported version is structurally the same case as an
      // unsupported eventType, not a separate code path.
      this.logger.warn(
        { event: "OUTBOX_EVENT_NO_CONSUMERS", domainEventId: row.id, eventType: row.eventType, workspaceId: row.workspaceId, correlationId },
        "no registered consumer for this eventType/version — left undispatched",
      );
      return { dispatched: false, skipped: true, consumerJobsCreated: 0, ownershipLost: false };
    }

    const leaseMs = this.config.get("outboxRelayClaimLeaseMs", { infer: true });

    // Renew before starting fan-out if meaningful time has elapsed since
    // the claim (e.g. earlier events in the same batch took a while).
    if (!(await this.maybeRenewClaim(row, correlationId, leaseMs))) {
      return { dispatched: false, skipped: false, consumerJobsCreated: 0, ownershipLost: true };
    }

    let consumerJobsCreated = 0;
    let allTerminal = true;

    for (const manifest of consumers) {
      // Renew between consumers — the mandatory minimum for multi-
      // consumer fan-out (Milestone 8.2 correctness fix item 3).
      if (!(await this.maybeRenewClaim(row, correlationId, leaseMs))) {
        return { dispatched: false, skipped: false, consumerJobsCreated, ownershipLost: true };
      }
      const outcome = await this.dispatchToConsumer(row, manifest, correlationId);
      if (outcome === "dispatched") consumerJobsCreated++;
      if (outcome === "transient-failure") allTerminal = false;
    }

    if (!allTerminal) {
      return { dispatched: false, skipped: false, consumerJobsCreated, ownershipLost: false };
    }

    // Renew once more before finalization if the lease is near expiry.
    // markDispatched's own claim_token guard would correctly no-op on a
    // genuinely stale claim regardless, but renewing here first avoids a
    // spurious "lost ownership" outcome for an event that is actually
    // still ours and simply took a while to fan out.
    if (!(await this.maybeRenewClaim(row, correlationId, leaseMs))) {
      return { dispatched: false, skipped: false, consumerJobsCreated, ownershipLost: true };
    }

    // "All required consumer enqueues succeed" (Milestone 8 Architecture
    // §7's sequencing requirement) means every consumer reached a
    // TERMINAL outcome for this attempt — either a genuine dispatch or a
    // permanent (never-retryable) failure — never that every consumer
    // literally succeeded. A permanent per-consumer failure (e.g. this
    // consumer's payload will never validate) must not block the OTHER,
    // valid consumers' dispatch from ever being finalized.
    const finalized = await this.markDispatched(row.id, row.claimToken);
    if (!finalized) {
      this.logger.warn(
        { event: "OUTBOX_EVENT_OWNERSHIP_LOST", domainEventId: row.id, eventType: row.eventType, workspaceId: row.workspaceId, correlationId },
        "finalize found this relay no longer owns the claim — another relay must have reclaimed it; not finalizing",
      );
      return { dispatched: false, skipped: false, consumerJobsCreated, ownershipLost: true };
    }

    return { dispatched: true, skipped: false, consumerJobsCreated, ownershipLost: false };
  }

  /**
   * One consumer's dispatch — its own short create-transaction, then the
   * BullMQ enqueue OUTSIDE it (mirrors SchedulerTickManager.
   * dispatchOccurrence's identical shape). Reuses the same idempotency-
   * key/conflict-recovery algorithm DEFECT-1F-003 established, and
   * isExpectedIdempotencyViolation imported unchanged from its existing
   * location (BackgroundJobsService itself cannot be called across the
   * API/Worker process boundary — see idempotency-violation.ts's own doc
   * comment for why this is a deliberate, already-approved duplication,
   * not a new one invented here).
   */
  private async dispatchToConsumer(row: ClaimedDomainEvent, manifest: EventConsumerManifest, correlationId: string): Promise<ConsumerDispatchOutcome> {
    const payload = plainToInstance(manifest.payloadDto, row.payload);
    const validationErrors = await validate(payload);
    const idempotencyKey = `event:${row.id}:consumer:${manifest.consumerName}`;
    // Deterministic, documented jobType derivation for a relayed
    // event-consumer job — deliberately NOT yet a registered
    // ProcessorManifest (Milestone 8.3's "consumer processing helper" is
    // explicitly out of this milestone's scope). Until that exists,
    // BullMqWorkerManager's own already-proven "no ProcessorManifest/
    // handler bound for job type" permanent-failure path applies to
    // these jobs unchanged — expected and accepted for this milestone,
    // which is fan-out/creation only, never execution.
    const jobType = `event.${manifest.consumerName}.v${manifest.eventContractVersion}`;

    if (validationErrors.length > 0) {
      return this.createPermanentFailureJob(row, manifest, idempotencyKey, jobType, payload, correlationId);
    }

    let jobRow: { id: string; status: string; errorCode: string | null };
    let wasReplay = false;
    try {
      jobRow = await this.prisma.$transaction(async (tx) => {
        const created = await tx.backgroundJob.create({
          data: {
            workspaceId: row.workspaceId,
            jobType,
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
      const existing = isExpectedIdempotencyViolation(error, row.workspaceId)
        ? await this.prisma.backgroundJob.findFirst({ where: { workspaceId: row.workspaceId, idempotencyKey } })
        : null;
      if (!existing) throw error;
      jobRow = existing;
      wasReplay = true;
    }

    // A found-via-replay row that is already durably, permanently
    // dead-lettered (createPermanentFailureJob, below) is terminal —
    // never re-added to BullMQ, never retried.
    if (wasReplay && jobRow.status === "FAILED" && jobRow.errorCode === PERMANENT_VALIDATION_ERROR_CODE) {
      return "permanent-failure";
    }
    // Forward-compatible guard, currently unreachable (nothing sets
    // COMPLETED on an outbox-created row yet — that's Milestone 8.3
    // execution scope): never re-add an already-completed job.
    if (wasReplay && jobRow.status === "COMPLETED") {
      return "dispatched";
    }

    // Re-dispatch decision (Milestone 8.2 correctness fix item 8):
    // Postgres status is authoritative for WHETHER to attempt this, never
    // BullMQ jobId dedup alone.
    //   - Freshly created -> always attempt add(), obviously.
    //   - status QUEUED via replay -> add() is REQUIRED for the crash-
    //     recovery case (this process, or a predecessor, committed the
    //     row but crashed before its own add() call or before that
    //     call's outcome could be recorded) and REDUNDANT-but-harmless
    //     otherwise (BullMQ's own jobId dedup absorbs an already-
    //     delivered duplicate) — Postgres can't cheaply distinguish
    //     those two cases without contacting BullMQ, so both are
    //     handled the same, safe way.
    //   - status FAILED/ENQUEUE_DISPATCH_FAILED via replay -> a prior
    //     attempt's add() genuinely failed and was synchronously
    //     compensated (see the catch block below); retrying add() here
    //     IS the retry — driven entirely by this relay's own reclaim
    //     loop, not a second retry engine.
    const wasFailedReplay = wasReplay && jobRow.status === "FAILED";

    try {
      await this.getDispatchQueue(manifest.queue).add(jobType, payload, {
        jobId: jobRow.id,
        attempts: 1,
        removeOnComplete: { age: 3_600 },
        removeOnFail: { age: 86_400 },
      });
    } catch (dispatchError) {
      await this.compensateDispatchFailure(jobRow.id, wasFailedReplay);
      this.logger.error(
        {
          event: "OUTBOX_CONSUMER_DISPATCH_FAILED",
          domainEventId: row.id,
          eventType: row.eventType,
          consumerName: manifest.consumerName,
          correlationId,
          err: { message: safeMessage(dispatchError) },
        },
        "consumer enqueue failed after Postgres commit — durably compensated to FAILED, will retry on the next relay reclaim",
      );
      return "transient-failure";
    }

    if (wasFailedReplay) {
      // The retry succeeded — the row MUST move back to QUEUED (not stay
      // FAILED), because BullMqWorkerManager's own pickup guard
      // (`WHERE id, status: "QUEUED"`) would otherwise silently skip this
      // now-genuinely-enqueued job as "not in QUEUED state at pickup",
      // permanently losing it despite BullMQ having it.
      await this.compensateRetrySuccess(jobRow.id);
    }

    return "dispatched";
  }

  /**
   * Milestone 8.2 correctness fix item 6 — a permanent per-consumer
   * payload-validation failure must be a durable BackgroundJob record,
   * not log-only. Uses the exact vocabulary BullMqWorkerManager.
   * deadLetterImmediately already established for "permanently rejected,
   * never executed" (schema.prisma's own BackgroundJob comment:
   * "DEAD_LETTERED -> terminal status=FAILED, deadLetteredAt set — a
   * marker, not a new status"). BackgroundJobHistory.fromStatus is left
   * null: its own documented convention ("the very first transition (job
   * creation) has no from") already covers a job whose first-ever
   * transition is straight to a terminal status — no fake RUNNING
   * execution is invented for a job the worker never picked up.
   */
  private async createPermanentFailureJob(
    row: ClaimedDomainEvent,
    manifest: EventConsumerManifest,
    idempotencyKey: string,
    jobType: string,
    payload: object,
    correlationId: string,
  ): Promise<ConsumerDispatchOutcome> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.backgroundJob.create({
          data: {
            workspaceId: row.workspaceId,
            jobType,
            queueName: manifest.queue,
            payloadMetadata: payload as unknown as Prisma.InputJsonValue,
            maxAttempts: manifest.defaultRetryPolicy?.maxAttempts ?? 1,
            idempotencyKey,
            correlationId,
            status: "FAILED",
            failedAt: new Date(),
            errorCode: PERMANENT_VALIDATION_ERROR_CODE,
            errorMessageSafe: "Event payload failed validation for this consumer.",
            deadLetteredAt: new Date(),
          },
        });
        await tx.backgroundJobHistory.create({
          data: { backgroundJobId: created.id, toStatus: "FAILED", detail: { errorCode: PERMANENT_VALIDATION_ERROR_CODE, deadLettered: true } },
        });
      });
    } catch (error) {
      const existing = isExpectedIdempotencyViolation(error, row.workspaceId)
        ? await this.prisma.backgroundJob.findFirst({ where: { workspaceId: row.workspaceId, idempotencyKey } })
        : null;
      // Already durably recorded by a prior reclaim of this same event —
      // nothing further to do; fall through to the terminal outcome.
      if (!existing) throw error;
    }

    this.logger.error(
      {
        event: "OUTBOX_EVENT_PAYLOAD_INVALID",
        domainEventId: row.id,
        eventType: row.eventType,
        consumerName: manifest.consumerName,
        workspaceId: row.workspaceId,
        correlationId,
      },
      "event payload failed validation for this consumer — permanent, durably recorded as a dead-lettered BackgroundJob, not retried",
    );
    return "permanent-failure";
  }

  /**
   * Milestone 8.2 correctness fix item 7 — synchronous, durable
   * compensation when the BullMQ add() call itself fails after the
   * Postgres row already committed, mirroring BackgroundJobsService.
   * enqueue()/SchedulerTickManager.dispatchOccurrence's own established
   * pattern (same target status/errorCode/errorMessageSafe shape) so a
   * failed dispatch never looks like a healthy pending QUEUED job. Goes
   * one step further than those two call sites by also persisting the
   * corresponding BackgroundJobHistory transition (they do not) — this
   * relay's own retry loop reads that history back via
   * dispatchToConsumer's re-dispatch decision, so the extra row is load-
   * bearing here, not cosmetic. Best-effort (`.catch`): this compensation
   * failing leaves the row looking QUEUED, which the next reclaim's own
   * add() attempt harmlessly retries regardless (see the QUEUED-via-
   * replay case in dispatchToConsumer) — never a correctness gap, only a
   * transient observability one.
   */
  private async compensateDispatchFailure(jobId: string, wasAlreadyFailed: boolean): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        const updated = await tx.backgroundJob.updateMany({
          where: { id: jobId, status: { not: "COMPLETED" } },
          data: { status: "FAILED", failedAt: new Date(), errorCode: TRANSIENT_DISPATCH_ERROR_CODE, errorMessageSafe: "Failed to dispatch job to the queue." },
        });
        if (updated.count === 0) return;
        await tx.backgroundJobHistory.create({
          data: {
            backgroundJobId: jobId,
            fromStatus: wasAlreadyFailed ? "FAILED" : "QUEUED",
            toStatus: "FAILED",
            detail: { errorCode: TRANSIENT_DISPATCH_ERROR_CODE, reason: wasAlreadyFailed ? "retry_attempt_also_failed" : "enqueue_dispatch_failed" },
          },
        });
      })
      .catch(() => undefined);
  }

  /**
   * The other half of item 7/item 8: a row previously compensated to
   * FAILED/ENQUEUE_DISPATCH_FAILED that this reclaim's add() call just
   * genuinely succeeded for MUST move back to QUEUED — not stay FAILED —
   * see dispatchToConsumer's own comment on why BullMqWorkerManager's
   * pickup guard requires this. Deliberately NOT best-effort/swallowed:
   * if this write itself fails, the inconsistency (BullMQ has it,
   * Postgres still says FAILED) is exactly the kind of thing this
   * relay's own reclaim loop self-heals on the next tick (add() is
   * retried, this update is retried) — allowing the error to propagate
   * up to handleTick's existing per-row isolation is correct, not a gap.
   */
  private async compensateRetrySuccess(jobId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.backgroundJob.updateMany({
        where: { id: jobId, status: "FAILED" },
        data: { status: "QUEUED", errorCode: null, errorMessageSafe: null, failedAt: null },
      });
      if (updated.count === 0) return;
      await tx.backgroundJobHistory.create({
        data: { backgroundJobId: jobId, fromStatus: "FAILED", toStatus: "QUEUED", detail: { reason: "outbox_relay_retry_succeeded" } },
      });
    });
  }

  /**
   * Transaction 2 — guarded on BOTH dispatched_at IS NULL and the exact
   * claim_token this attempt was issued, so a stale owner (lease expired,
   * reclaimed by someone else) affects zero rows rather than overwriting
   * a newer claim's in-flight state. On success, clears the lease columns
   * along with setting dispatched_at — a finalized row is not "claimed by
   * nobody in particular," it is simply done.
   */
  private async markDispatched(domainEventId: string, claimToken: string): Promise<boolean> {
    const result = await this.prisma.domainEvent.updateMany({
      where: { id: domainEventId, claimToken, dispatchedAt: null },
      data: { dispatchedAt: new Date(), claimToken: null, claimedAt: null, claimExpiresAt: null },
    });
    return result.count > 0;
  }

  /**
   * DEFECT-1F-005 (final call site). Same rationale as
   * BullMqWorkerManager.getQueue()'s own doc comment — this Queue's
   * underlying RedisConnection is `shared: true` (this.connection is a
   * live ioredis instance), so a zero-listener 'error' emission is
   * otherwise possible. Attached once, at construction.
   */
  private getDispatchQueue(queueName: string): Queue {
    if (!this.connection) {
      throw new Error("OutboxRelayManager.getDispatchQueue() called before onApplicationBootstrap");
    }
    let queue = this.dispatchQueues.get(queueName);
    if (!queue) {
      queue = new Queue(queueName, { connection: this.connection });
      queue.on("error", (error) => {
        this.logger.error({ err: error, queueName }, "outbox relay dispatch queue error");
      });
      this.dispatchQueues.set(queueName, queue);
    }
    return queue;
  }

  /**
   * DEFECT-1F-001's bounded-shutdown pattern, reused unchanged — see
   * BullMqWorkerManager/SchedulerTickManager's identical
   * onApplicationShutdown for the full rationale (Worker.close(true)
   * for BullMQ's own internally-duplicated blocking connection,
   * connection.disconnect() for the caller-owned one, neither awaited
   * in the force phase). DEFECT-1F-005: the force phase now also closes
   * every cached dispatchQueues entry — previously only the graceful
   * phase did, leaving a Queue created while Redis was unreachable
   * orphaned past shutdown (same gap already fixed in
   * BullMqWorkerManager.onApplicationShutdown).
   */
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

    this.shutdownTracker.record(OutboxRelayManager.name, outcome);
    if (outcome !== "GRACEFUL") {
      const level = outcome === "FAILED" ? "error" : "warn";
      this.logger[level](
        { event: outcome === "FAILED" ? "REDIS_SHUTDOWN_FAILED" : "REDIS_SHUTDOWN_FORCED", component: OutboxRelayManager.name, deadlineMs },
        outcome === "FAILED" ? "shutdown force-close also failed" : "graceful shutdown exceeded the deadline — forced disconnect",
      );
    }
  }
}
