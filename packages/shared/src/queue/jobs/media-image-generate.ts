import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 7 Phase 7.4 — durable image-generation job. Dispatches through
 * Module 1F's Queue Engine on `QueueName.MEDIA` (frozen §3: "Image/Voice
 * generation" — dedicated isolated workers). Media binary work is
 * deliberately NOT routed through `ai.execute.v1`.
 *
 * The payload is minimal — a reference to the real `media_jobs` business
 * record, never the prompt, provider output, or credentials. The worker
 * processor resolves everything from this one id.
 */
export class MediaImageGenerateV1Payload {
  @IsUUID()
  mediaJobPublicId!: string;
}

export class MediaImageGenerateV1Result {
  @IsUUID()
  mediaJobPublicId!: string;
}

export const MEDIA_IMAGE_GENERATE_V1_MANIFEST: ProcessorManifest<MediaImageGenerateV1Payload, MediaImageGenerateV1Result> = {
  jobType: "media.image-generate.v1",
  schemaVersion: 1,
  version: 1,
  queue: "MEDIA",
  payloadDto: MediaImageGenerateV1Payload,
  resultDto: MediaImageGenerateV1Result,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  // Frozen Retry Strategy defaults (QUEUE_AND_BACKGROUND_JOB_ENGINE_V1.0.md §7).
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  // Per-attempt ceiling; strictly < maximumRuntime. Image generation is
  // ~10-25s in practice — 120s leaves headroom for the object write +
  // MediaAsset creation that follow the provider call inside the handler.
  timeout: 120_000,
  maximumRuntime: 300_000,
  owningModule: "media-generation",
  description: "Generate one image via the configured image provider and persist it as an ACTIVE MediaAsset.",
};
