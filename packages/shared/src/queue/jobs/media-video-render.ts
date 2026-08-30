import { IsUUID } from "class-validator";
import type { ProcessorManifest } from "../processor-manifest";

/**
 * Module 7 Phase 7.5 — durable video-render job on `QueueName.MEDIA`
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md §7; the frozen Queue Engine lists
 * "Video Rendering" under the MEDIA category with dedicated isolated
 * workers and a 2-concurrent-renders global cap).
 *
 * The BullMQ payload carries ONLY the stable render-job identity — never
 * the render input snapshot, media binaries, scripts, credentials, or
 * scene plans. The worker loads the frozen `VideoRenderInputV1` snapshot
 * from the `video_render_jobs` row (checkpoint §3).
 */
export class MediaVideoRenderV1Payload {
  @IsUUID()
  videoRenderJobPublicId!: string;
}

export class MediaVideoRenderV1Result {
  @IsUUID()
  videoRenderJobPublicId!: string;
}

/** 45-minute hard ceiling (FRD §21.1). Renders resume rather than restart on retry (FR-VID-007). */
const RENDER_TIMEOUT_MS = 45 * 60 * 1000;

export const MEDIA_VIDEO_RENDER_V1_MANIFEST: ProcessorManifest<MediaVideoRenderV1Payload, MediaVideoRenderV1Result> = {
  jobType: "media.video-render.v1",
  schemaVersion: 1,
  version: 1,
  queue: "MEDIA",
  payloadDto: MediaVideoRenderV1Payload,
  resultDto: MediaVideoRenderV1Result,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  timeout: RENDER_TIMEOUT_MS,
  maximumRuntime: RENDER_TIMEOUT_MS,
  owningModule: "video-render",
  description: "Render the final video from a frozen VideoRenderInputV1 snapshot and persist an ACTIVE VIDEO MediaAsset.",
};
