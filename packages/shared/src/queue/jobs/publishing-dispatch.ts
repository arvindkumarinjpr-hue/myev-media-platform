import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 9 Phase 9.3 — the scheduled-dispatch job type. This is the
 * `ScheduledJob.jobType` a due publish-schedule occurrence dispatches
 * as (via SchedulerTickManager, unmodified) — its own processor's ONLY
 * job is to transition the target SCHEDULED -> QUEUED and enqueue a
 * separate `publishing.execute.v1` BackgroundJob; it never calls a
 * provider itself (Part S/Part I).
 */
export class PublishingDispatchV1Payload {
  @IsUUID()
  workspacePublicId!: string;

  @IsUUID()
  publicationTargetPublicId!: string;
}

export class PublishingDispatchV1Result {
  @IsUUID()
  publicationTargetPublicId!: string;
}

export const PUBLISHING_DISPATCH_V1_MANIFEST: ProcessorManifest<PublishingDispatchV1Payload, PublishingDispatchV1Result> = {
  jobType: "publishing.dispatch.v1",
  schemaVersion: 1,
  version: 1,
  queue: "PUBLISHING",
  payloadDto: PublishingDispatchV1Payload,
  resultDto: PublishingDispatchV1Result,
  idempotent: true,
  cancelable: false,
  // A dispatch handoff is a single, cheap, mechanical DB write (no
  // external call) — a real failure here almost always means the target
  // itself is in an illegal state (already dispatched, cancelled), which
  // retrying would never fix. Non-retryable by design; a genuinely
  // transient DB error at this scale is rare enough that the scheduler's
  // own next-tick recovery (missed-occurrence handling) is a sufficient
  // backstop.
  supportsRetry: false,
  timeout: 30_000,
  maximumRuntime: 30_000,
  owningModule: "publishing",
  description: "Scheduled publish dispatch — transitions one due PublicationTarget SCHEDULED -> QUEUED and enqueues its publishing.execute.v1 job. Never calls a provider.",
};
