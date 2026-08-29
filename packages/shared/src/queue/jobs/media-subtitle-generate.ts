import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 7 Phase 7.4 — deterministic subtitle-generation job on
 * `QueueName.MEDIA`. No AI, no STT — the processor reads the approved
 * script + the current voice artifact's word timings and runs
 * `buildSubtitles`. It is a job (not inline) so it stays on the isolated
 * MEDIA workers and inherits the same retry/reconciliation machinery.
 */
export class MediaSubtitleGenerateV1Payload {
  @IsUUID()
  mediaJobPublicId!: string;
}

export class MediaSubtitleGenerateV1Result {
  @IsUUID()
  mediaJobPublicId!: string;
}

export const MEDIA_SUBTITLE_GENERATE_V1_MANIFEST: ProcessorManifest<MediaSubtitleGenerateV1Payload, MediaSubtitleGenerateV1Result> = {
  jobType: "media.subtitle-generate.v1",
  schemaVersion: 1,
  version: 1,
  queue: "MEDIA",
  payloadDto: MediaSubtitleGenerateV1Payload,
  resultDto: MediaSubtitleGenerateV1Result,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  // Deterministic and CPU-only — fast. 30s per attempt is generous.
  timeout: 30_000,
  maximumRuntime: 90_000,
  owningModule: "media-generation",
  description: "Deterministically build SRT + VTT from the approved script and the voice artifact's word timings; persist ACTIVE SUBTITLE MediaAssets.",
};
