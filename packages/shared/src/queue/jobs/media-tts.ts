import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 7 Phase 7.4 — durable text-to-speech job on `QueueName.MEDIA`.
 * Minimal reference-only payload — the `media_jobs` row holds the script
 * text hash, voice profile, and language; the processor resolves them.
 */
export class MediaTtsV1Payload {
  @IsUUID()
  mediaJobPublicId!: string;
}

export class MediaTtsV1Result {
  @IsUUID()
  mediaJobPublicId!: string;
}

export const MEDIA_TTS_V1_MANIFEST: ProcessorManifest<MediaTtsV1Payload, MediaTtsV1Result> = {
  jobType: "media.tts.v1",
  schemaVersion: 1,
  version: 1,
  queue: "MEDIA",
  payloadDto: MediaTtsV1Payload,
  resultDto: MediaTtsV1Result,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  // Long-form scripts synthesize slower than a single image; 180s per
  // attempt, 360s absolute.
  timeout: 180_000,
  maximumRuntime: 360_000,
  owningModule: "media-generation",
  description: "Synthesize narration audio + word-level timings via the configured TTS provider and persist an ACTIVE AUDIO MediaAsset.",
};
