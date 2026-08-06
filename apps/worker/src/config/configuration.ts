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
  return {
    env: process.env.NODE_ENV ?? "development",
    logLevel: process.env.LOG_LEVEL ?? "info",
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    applicationVersion: process.env.WORKER_APPLICATION_VERSION ?? "0.1.0",
    queues: parseQueues(process.env.WORKER_QUEUES),
    heartbeatIntervalMs: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "15000", 10),
  };
}
