import { readWorkerCoreConfig, WorkerConfigError, type WorkerCoreConfig } from "@myev/worker-core";

export { WorkerConfigError };

/**
 * The general worker's configuration = the shared `WorkerCoreConfig`
 * (@myev/worker-core) + this process's own app-specific keys: the
 * scheduler tick, the outbox relay, and the AI text providers.
 *
 * This process runs SYSTEM / AI work only. It has NO media, storage, or
 * render configuration — the dedicated render/media worker
 * (`apps/render-worker`) owns those, along with Remotion and every
 * heavy render dependency.
 */
export interface WorkerConfig extends WorkerCoreConfig {
  // Module 1F Milestone 7 (Scheduler Foundation), Revision 3 §13.
  schedulerTickIntervalMs: number;
  schedulerBatchSize: number;
  // Milestone 8.2 (OutboxRelayManager) — Milestone 8 Architecture §14/§20.
  outboxRelayIntervalMs: number;
  outboxRelayBatchSize: number;
  outboxRelayClaimLeaseMs: number;
  // Module 3 Phase 3.4 — real vendor credentials for ai.execute.v1;
  // an empty apiKey leaves that provider unconfigured rather than crashing.
  ai: {
    openai: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string };
    gemini: { apiKey: string; model: string };
  };
  // Module 9 Phase 9.3 — the same PublishingCredentialCryptoService key
  // apps/api reads (apps/api/src/config/configuration.ts's own
  // `publishing.credentialEncryptionKey`), duplicated here because the
  // two processes read their own config independently (never a shared
  // ConfigService instance). An empty/malformed value fails lazily
  // inside the shared encrypt/decrypt primitive itself, never at
  // startup — identical convention to apps/api's own.
  publishing: {
    credentialEncryptionKey: string;
    // Module 9 Phase 9.5 — mirrors apps/api's own identically-named
    // key exactly (its own doc comment explains why this is a platform
    // secret, unlike WordPress's per-workspace credentials).
    youtube: { oauthClientId: string; oauthClientSecret: string };
    // Module 9 Phase 9.6 — Meta's own registered App id, required by
    // FacebookChannelProvider's resumable-upload session endpoint
    // (`/APP_ID/uploads`). Research finding: unlike YouTube, no app
    // secret is needed at runtime (no OAuth token exchange happens in
    // this phase — Phase 9.7 owns that), and InstagramChannelProvider
    // needs no platform-level app credential at all (its resumable
    // upload path is scoped by the per-workspace container id, not an
    // app id) — mirrors apps/api's own identically-named key.
    meta: { appId: string };
  };
}

export default function configuration(): WorkerConfig {
  const core = readWorkerCoreConfig();

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
    ...core,
    schedulerTickIntervalMs: parseInt(process.env.SCHEDULER_TICK_INTERVAL_MS ?? "60000", 10),
    schedulerBatchSize: parseInt(process.env.SCHEDULER_BATCH_SIZE ?? "100", 10),
    outboxRelayIntervalMs,
    outboxRelayBatchSize,
    outboxRelayClaimLeaseMs,
    ai: {
      openai: { apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.OPENAI_MODEL ?? "gpt-4o" },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20241022" },
      gemini: { apiKey: process.env.GEMINI_API_KEY ?? "", model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro" },
    },
    publishing: {
      credentialEncryptionKey: process.env.PUBLISHING_CREDENTIAL_ENCRYPTION_KEY ?? "",
      youtube: { oauthClientId: process.env.YOUTUBE_OAUTH_CLIENT_ID ?? "", oauthClientSecret: process.env.YOUTUBE_OAUTH_CLIENT_SECRET ?? "" },
      meta: { appId: process.env.META_APP_ID ?? "" },
    },
  };
}
