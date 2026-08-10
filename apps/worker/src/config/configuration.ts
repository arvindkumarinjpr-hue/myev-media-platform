import { QUEUE_NAMES, isQueueName, type QueueName } from "@myev/shared";

export interface WorkerConfig {
  env: string;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  // Sourced from WorkerHeartbeat.applicationVersion (Module 1F Engineering
  // Plan, Worker Heartbeat architecture) — stamped onto every job this
  // process executes as background_jobs.processor_version.
  applicationVersion: string;
  // This worker instance's own --queues= selection — the exact set the
  // bijective handler<->manifest bootstrap validation is scoped to (see
  // QueueRegistryBuilder.freeze in @myev/shared).
  queues: QueueName[];
  heartbeatIntervalMs: number;
  // Module 1F Milestone 7 (Scheduler Foundation), Revision 3 §13 —
  // approved defaults, configuration-backed rather than hardcoded inline.
  schedulerTickIntervalMs: number;
  schedulerBatchSize: number;
  // DEFECT-1F-004: bounds how long a single scheduler-registration attempt
  // (queue.upsertJobScheduler, a real Redis round-trip) may wait before
  // onApplicationBootstrap gives up on THIS attempt and lets application
  // bootstrap proceed anyway — never how long bootstrap itself blocks.
  schedulerRegistrationTimeoutMs: number;
  // Fixed interval between background retry attempts once the first one
  // has timed out — bounded, not exponential, not aggressive (matches
  // BullMQ's own capped-linear reconnect delay in spirit).
  schedulerRegistrationRetryIntervalMs: number;
  // DEFECT-1F-001: bounds how long a component's graceful Redis shutdown
  // sequence (Worker.close()/Queue.close()/connection.quit()) may wait
  // before falling back to a forced disconnect. One value governs every
  // Redis-connected component in this process — see
  // @myev/shared's boundedShutdown.
  redisShutdownDeadlineMs: number;
  // Milestone 8.2 (OutboxRelayManager) — Milestone 8 Architecture §14/§20
  // approved starting defaults, no dynamic autoscaling yet. Reuses
  // schedulerRegistrationTimeoutMs/schedulerRegistrationRetryIntervalMs
  // for its own BullMQ scheduler-registration bounding (the same generic
  // "how long to wait for a upsertJobScheduler call" concern
  // SchedulerTickManager already has config for — not duplicated here).
  outboxRelayIntervalMs: number;
  outboxRelayBatchSize: number;
  // Milestone 8.2 correctness fix — how long a claimed-but-not-yet-
  // finalized DomainEvent's lease stays exclusive to the relay instance
  // holding it, before it becomes eligible for another relay to reclaim.
  // Renewed (extended) while genuine dispatch work is still in progress;
  // only actually expires if the owning relay crashed or was killed
  // mid-dispatch. Must comfortably exceed normal end-to-end dispatch
  // latency for a full batch — too short causes needless duplicate
  // dispatch attempts (still safe, via idempotency, but wasteful); too
  // long only delays crash recovery, never causes incorrect behavior.
  outboxRelayClaimLeaseMs: number;
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

function parseQueues(raw: string | undefined): QueueName[] {
  if (!raw?.trim()) {
    throw new WorkerConfigError(
      "WORKER_QUEUES is not set — a worker process must declare which queue(s) it processes " +
        "(comma-separated, e.g. WORKER_QUEUES=SYSTEM,MAINTENANCE)",
    );
  }
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const invalid = names.filter((name) => !isQueueName(name));
  if (invalid.length > 0) {
    throw new WorkerConfigError(`WORKER_QUEUES contains unrecognized queue name(s): ${invalid.join(", ")} (recognized: ${QUEUE_NAMES.join(", ")})`);
  }
  return names as QueueName[];
}

/**
 * All values are read from environment variables only. Deliberately
 * throws (rather than defaulting silently) for DATABASE_URL/REDIS_URL/
 * WORKER_QUEUES — a worker missing any of these cannot safely start, and
 * failing during config resolution (before NestFactory.createApplicationContext
 * even runs) is the earliest possible fail-fast point.
 */
export default function configuration(): WorkerConfig {
  if (!process.env.DATABASE_URL?.trim()) {
    throw new WorkerConfigError("DATABASE_URL is not set — worker cannot reach Postgres");
  }
  if (!process.env.REDIS_URL?.trim()) {
    throw new WorkerConfigError("REDIS_URL is not set — worker cannot reach Redis");
  }

  const outboxRelayIntervalMs = parseInt(process.env.OUTBOX_RELAY_INTERVAL_MS ?? "2000", 10);
  if (!Number.isInteger(outboxRelayIntervalMs) || outboxRelayIntervalMs <= 0) {
    throw new WorkerConfigError("OUTBOX_RELAY_INTERVAL_MS must be a positive integer");
  }
  const outboxRelayBatchSize = parseInt(process.env.OUTBOX_RELAY_BATCH_SIZE ?? "50", 10);
  if (!Number.isInteger(outboxRelayBatchSize) || outboxRelayBatchSize <= 0) {
    throw new WorkerConfigError("OUTBOX_RELAY_BATCH_SIZE must be a positive integer");
  }
  const outboxRelayClaimLeaseMs = parseInt(process.env.OUTBOX_RELAY_CLAIM_LEASE_MS ?? "30000", 10);
  if (!Number.isInteger(outboxRelayClaimLeaseMs) || outboxRelayClaimLeaseMs <= 0) {
    throw new WorkerConfigError("OUTBOX_RELAY_CLAIM_LEASE_MS must be a positive integer");
  }

  return {
    env: process.env.NODE_ENV ?? "development",
    logLevel: process.env.LOG_LEVEL ?? "info",
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    applicationVersion: process.env.WORKER_APPLICATION_VERSION ?? "0.1.0",
    queues: parseQueues(process.env.WORKER_QUEUES),
    heartbeatIntervalMs: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "15000", 10),
    schedulerTickIntervalMs: parseInt(process.env.SCHEDULER_TICK_INTERVAL_MS ?? "60000", 10),
    schedulerBatchSize: parseInt(process.env.SCHEDULER_BATCH_SIZE ?? "100", 10),
    schedulerRegistrationTimeoutMs: parseInt(process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS ?? "5000", 10),
    schedulerRegistrationRetryIntervalMs: parseInt(process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS ?? "10000", 10),
    redisShutdownDeadlineMs: parseInt(process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "5000", 10),
    outboxRelayIntervalMs,
    outboxRelayBatchSize,
    outboxRelayClaimLeaseMs,
  };
}
