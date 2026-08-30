import { QUEUE_NAMES, isQueueName, type QueueName } from "@myev/shared";

/**
 * The configuration every worker process shares — read by the framework
 * infrastructure in this package (BullMqWorkerManager, the heartbeat, the
 * reconciliation sweep, the media persistence services). Each app's own
 * `configuration.ts` produces a `WorkerConfig extends WorkerCoreConfig`,
 * spreading `readWorkerCoreConfig()` and adding its app-specific keys.
 */
export interface WorkerCoreConfig {
  env: string;
  logLevel: string;
  databaseUrl: string;
  redisUrl: string;
  /** Sourced from WorkerHeartbeat.applicationVersion; stamped onto every job as background_jobs.processor_version. */
  applicationVersion: string;
  /** This process's own WORKER_QUEUES selection — the bijective handler<->manifest validation is scoped to it. */
  queues: QueueName[];
  heartbeatIntervalMs: number;
  /** DEFECT-1F-001 bounded-shutdown deadline for every Redis-connected component. */
  redisShutdownDeadlineMs: number;
  /** DEFECT-1F-004 / -006 — how long one upsertJobScheduler attempt may wait, and the retry interval after a timeout. */
  schedulerRegistrationTimeoutMs: number;
  schedulerRegistrationRetryIntervalMs: number;
  /** DEFECT-1F-006 — the reconciliation sweep interval + per-tick candidate cap. */
  backgroundJobReconciliationIntervalMs: number;
  backgroundJobReconciliationBatchSize: number;
  /**
   * Per-queue concurrency for the MEDIA queue only (image/voice/subtitle/
   * video-render). Frozen: 2 concurrent renders global (FRD §21.1) — a
   * single render can saturate a CPU. Every other queue uses the default.
   */
  mediaQueueConcurrency: number;
  /** Object-storage target for worker-originated media writes (@aws-sdk/client-s3). */
  storage: {
    endpoint: string;
    port: number;
    useSsl: boolean;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
    providerIdentity: string;
    /** Whether the worker may CREATE its bucket when HeadBucket reports it missing (default true; production S3/R2 → false). */
    autoCreateBucket: boolean;
  };
  media: {
    maxImageBytes: number;
    maxAudioBytes: number;
    maxSubtitleBytes: number;
    maxVideoBytes: number;
  };
}

export class WorkerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConfigError";
  }
}

export function parseQueues(raw: string | undefined): QueueName[] {
  if (!raw?.trim()) {
    throw new WorkerConfigError(
      "WORKER_QUEUES is not set — a worker process must declare which queue(s) it processes (comma-separated, e.g. WORKER_QUEUES=SYSTEM,MAINTENANCE)",
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

function positiveInt(raw: string | undefined, fallback: number, name: string): number {
  const value = parseInt(raw ?? String(fallback), 10);
  if (!Number.isInteger(value) || value <= 0) {
    throw new WorkerConfigError(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * Reads the shared worker configuration from environment variables only.
 * Throws (rather than defaulting silently) for DATABASE_URL / REDIS_URL /
 * WORKER_QUEUES — a worker missing any of these cannot safely start.
 */
export function readWorkerCoreConfig(): WorkerCoreConfig {
  if (!process.env.DATABASE_URL?.trim()) throw new WorkerConfigError("DATABASE_URL is not set — worker cannot reach Postgres");
  if (!process.env.REDIS_URL?.trim()) throw new WorkerConfigError("REDIS_URL is not set — worker cannot reach Redis");

  return {
    env: process.env.NODE_ENV ?? "development",
    logLevel: process.env.LOG_LEVEL ?? "info",
    databaseUrl: process.env.DATABASE_URL,
    redisUrl: process.env.REDIS_URL,
    applicationVersion: process.env.WORKER_APPLICATION_VERSION ?? "0.1.0",
    queues: parseQueues(process.env.WORKER_QUEUES),
    heartbeatIntervalMs: parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? "15000", 10),
    redisShutdownDeadlineMs: parseInt(process.env.REDIS_SHUTDOWN_DEADLINE_MS ?? "5000", 10),
    schedulerRegistrationTimeoutMs: parseInt(process.env.SCHEDULER_REGISTRATION_TIMEOUT_MS ?? "5000", 10),
    schedulerRegistrationRetryIntervalMs: parseInt(process.env.SCHEDULER_REGISTRATION_RETRY_INTERVAL_MS ?? "10000", 10),
    backgroundJobReconciliationIntervalMs: positiveInt(process.env.BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS, 30000, "BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS"),
    backgroundJobReconciliationBatchSize: positiveInt(process.env.BACKGROUND_JOB_RECONCILIATION_BATCH_SIZE, 50, "BACKGROUND_JOB_RECONCILIATION_BATCH_SIZE"),
    mediaQueueConcurrency: parseInt(process.env.RENDER_CONCURRENCY ?? "2", 10),
    storage: {
      endpoint: process.env.STORAGE_ENDPOINT ?? "localhost",
      port: parseInt(process.env.STORAGE_PORT ?? "9000", 10),
      useSsl: (process.env.STORAGE_USE_SSL ?? "false") === "true",
      region: process.env.STORAGE_REGION ?? "us-east-1",
      bucket: process.env.STORAGE_BUCKET ?? "myev-media",
      accessKey: process.env.STORAGE_ACCESS_KEY ?? "",
      secretKey: process.env.STORAGE_SECRET_KEY ?? "",
      forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? "true") === "true",
      providerIdentity: process.env.STORAGE_PROVIDER_IDENTITY ?? "MINIO",
      autoCreateBucket: (process.env.MEDIA_STORAGE_AUTO_CREATE_BUCKET ?? "true") === "true",
    },
    media: {
      maxImageBytes: parseInt(process.env.MEDIA_MAX_SIZE_IMAGE_BYTES ?? "26214400", 10),
      maxAudioBytes: parseInt(process.env.MEDIA_MAX_SIZE_AUDIO_BYTES ?? "104857600", 10),
      maxSubtitleBytes: parseInt(process.env.MEDIA_MAX_SIZE_SUBTITLE_BYTES ?? "1048576", 10),
      maxVideoBytes: parseInt(process.env.MEDIA_MAX_SIZE_VIDEO_BYTES ?? "2147483648", 10),
    },
  };
}
