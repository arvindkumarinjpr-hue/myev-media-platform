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
  // DEFECT-1F-006 — BackgroundJobReconciliationManager. How often the
  // reconciliation tick scans for stale RUNNING rows, and how many
  // candidates it inspects per tick. Deliberately no separate stale-age
  // setting: manifest.timeout (already declared per job type) is the
  // authoritative per-attempt staleness bound — see that class's own doc
  // comment.
  backgroundJobReconciliationIntervalMs: number;
  backgroundJobReconciliationBatchSize: number;
  // Module 3 Phase 3.4 — real vendor credentials, read here only, mirroring
  // apps/api's own identical AppConfig.ai shape (see that file's doc
  // comment for the full rationale — an empty apiKey leaves that provider
  // unconfigured rather than crashing this process).
  ai: {
    openai: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string };
    gemini: { apiKey: string; model: string };
  };
  // Module 7 Phase 7.4 — Media generation. `mediaProviders` selects which
  // image/TTS adapter the MEDIA processors resolve. Default is "fake"
  // (deterministic, zero spend) — a real provider is used only when its
  // id is set AND its credentials are present. `storage` is the
  // worker-side object-write target (S3PutClient); it mirrors apps/api's
  // AppConfig.storage shape.
  storage: {
    endpoint: string;
    port: number;
    useSsl: boolean;
    region: string;
    bucket: string;
    accessKey: string;
    secretKey: string;
    forcePathStyle: boolean;
  };
  mediaProviders: {
    imageProviderId: string; // "fake" | "openai"
    openaiImageModel: string;
    ttsProviderId: string; // "fake" | "azure"
    azureSpeechKey: string;
    azureSpeechRegion: string;
  };
  media: {
    maxImageBytes: number;
    maxAudioBytes: number;
    maxSubtitleBytes: number;
  };
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
  const backgroundJobReconciliationIntervalMs = parseInt(process.env.BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS ?? "30000", 10);
  if (!Number.isInteger(backgroundJobReconciliationIntervalMs) || backgroundJobReconciliationIntervalMs <= 0) {
    throw new WorkerConfigError("BACKGROUND_JOB_RECONCILIATION_INTERVAL_MS must be a positive integer");
  }
  const backgroundJobReconciliationBatchSize = parseInt(process.env.BACKGROUND_JOB_RECONCILIATION_BATCH_SIZE ?? "50", 10);
  if (!Number.isInteger(backgroundJobReconciliationBatchSize) || backgroundJobReconciliationBatchSize <= 0) {
    throw new WorkerConfigError("BACKGROUND_JOB_RECONCILIATION_BATCH_SIZE must be a positive integer");
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
    backgroundJobReconciliationIntervalMs,
    backgroundJobReconciliationBatchSize,
    ai: {
      openai: { apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.OPENAI_MODEL ?? "gpt-4o" },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20241022" },
      gemini: { apiKey: process.env.GEMINI_API_KEY ?? "", model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro" },
    },
    storage: {
      endpoint: process.env.STORAGE_ENDPOINT ?? "localhost",
      port: parseInt(process.env.STORAGE_PORT ?? "9000", 10),
      useSsl: (process.env.STORAGE_USE_SSL ?? "false") === "true",
      region: process.env.STORAGE_REGION ?? "us-east-1",
      bucket: process.env.STORAGE_BUCKET ?? "myev-media",
      accessKey: process.env.STORAGE_ACCESS_KEY ?? "",
      secretKey: process.env.STORAGE_SECRET_KEY ?? "",
      forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE ?? "true") === "true",
    },
    mediaProviders: {
      imageProviderId: process.env.MEDIA_IMAGE_PROVIDER ?? "fake",
      openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
      ttsProviderId: process.env.MEDIA_TTS_PROVIDER ?? "fake",
      azureSpeechKey: process.env.AZURE_SPEECH_KEY ?? "",
      azureSpeechRegion: process.env.AZURE_SPEECH_REGION ?? "",
    },
    media: {
      maxImageBytes: parseInt(process.env.MEDIA_MAX_SIZE_IMAGE_BYTES ?? "26214400", 10),
      maxAudioBytes: parseInt(process.env.MEDIA_MAX_SIZE_AUDIO_BYTES ?? "104857600", 10),
      maxSubtitleBytes: parseInt(process.env.MEDIA_MAX_SIZE_SUBTITLE_BYTES ?? "1048576", 10),
    },
  };
}
