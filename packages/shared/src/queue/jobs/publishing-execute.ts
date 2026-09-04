import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 9 Phase 9.3 — the durable publish-execution job type. Dispatches
 * through the existing Queue Engine exactly like ai.execute.v1 (no new
 * queue system) on the PUBLISHING queue, bound to the general apps/worker
 * process. The payload is deliberately minimal: a reference to the real
 * business record (publication_targets), never the decrypted credential,
 * content body, media bytes, or any provider payload — the worker
 * processor resolves everything else from this one id at execution time.
 */
export class PublishingExecuteV1Payload {
  /** The workspace's own public_id — every mechanical fetch this job's processor performs is scoped to it. */
  @IsUUID()
  workspacePublicId!: string;

  /** The PublicationTarget's own public_id — never its internal id. */
  @IsUUID()
  publicationTargetPublicId!: string;
}

export class PublishingExecuteV1Result {
  @IsUUID()
  publicationTargetPublicId!: string;
}

export const PUBLISHING_EXECUTE_V1_MANIFEST: ProcessorManifest<PublishingExecuteV1Payload, PublishingExecuteV1Result> = {
  jobType: "publishing.execute.v1",
  schemaVersion: 1,
  version: 1,
  queue: "PUBLISHING",
  payloadDto: PublishingExecuteV1Payload,
  resultDto: PublishingExecuteV1Result,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  // Bounded retry, no invented numbers — same shape as AI_EXECUTE_V1_MANIFEST's
  // own defaults (max 3 attempts, capped exponential backoff). Only the
  // fixture provider is registered this phase; a real connector's own
  // timeout/retry needs are a later phase's tuning concern, not this one's.
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  timeout: 120_000,
  maximumRuntime: 300_000,
  owningModule: "publishing",
  description: "Durable publish execution — drives exactly one existing PublicationTarget row to PUBLISHED or FAILED via the resolved channel provider.",
};
