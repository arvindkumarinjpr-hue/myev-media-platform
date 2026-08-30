import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  MEDIA_IMAGE_GENERATE_V1_MANIFEST,
  MEDIA_SUBTITLE_GENERATE_V1_MANIFEST,
  MEDIA_TTS_V1_MANIFEST,
  MEDIA_VIDEO_RENDER_V1_MANIFEST,
  QueueRegistryBuilder,
  type QueueRegistry,
} from "@myev/shared";
import { QUEUE_REGISTRY } from "@myev/worker-core";
import type { WorkerConfig } from "../config/configuration";
import { MediaProviderRegistryModule } from "../media-provider/media-provider-registry.module";
import { RenderEngineModule } from "../render/render-engine.module";
import { MediaImageGenerateProcessor } from "./processors/media-image-generate.processor";
import { MediaTtsProcessor } from "./processors/media-tts.processor";
import { MediaSubtitleGenerateProcessor } from "./processors/media-subtitle-generate.processor";
import { VideoRenderProcessor } from "./processors/video-render.processor";

export { QUEUE_REGISTRY };

/**
 * The dedicated render / media worker's QueueRegistry — it owns the
 * ENTIRE MEDIA queue: image, voice, subtitle generation AND video
 * rendering (`media.video-render.v1`). It is the only process type that
 * consumes MEDIA (frozen "MEDIA = dedicated isolated workers"); the
 * general worker (`apps/worker`) registers none of these manifests and
 * never opens a BullMQ worker on MEDIA, so a MEDIA job can never reach
 * it and a render crash can never touch SYSTEM/AI work (checkpoint §27).
 *
 * All four handlers are bound because there is exactly one MEDIA
 * consumer — BullMQ has no per-job-name routing, so any un-bound MEDIA
 * job type would be dead-lettered. The bijection freeze
 * (`requireHandlersForQueues: ["MEDIA"]`) enforces that every registered
 * MEDIA manifest has a handler.
 */
@Global()
@Module({
  imports: [ConfigModule, MediaProviderRegistryModule, RenderEngineModule],
  providers: [
    MediaImageGenerateProcessor,
    MediaTtsProcessor,
    MediaSubtitleGenerateProcessor,
    VideoRenderProcessor,
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService, MediaImageGenerateProcessor, MediaTtsProcessor, MediaSubtitleGenerateProcessor, VideoRenderProcessor],
      useFactory: (
        config: ConfigService<WorkerConfig, true>,
        mediaImage: MediaImageGenerateProcessor,
        mediaTts: MediaTtsProcessor,
        mediaSubtitle: MediaSubtitleGenerateProcessor,
        videoRender: VideoRenderProcessor,
      ): QueueRegistry => {
        const builder = new QueueRegistryBuilder();

        builder.registerManifest(MEDIA_IMAGE_GENERATE_V1_MANIFEST);
        builder.bindHandler(MEDIA_IMAGE_GENERATE_V1_MANIFEST.jobType, mediaImage.handle);
        builder.registerManifest(MEDIA_TTS_V1_MANIFEST);
        builder.bindHandler(MEDIA_TTS_V1_MANIFEST.jobType, mediaTts.handle);
        builder.registerManifest(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST);
        builder.bindHandler(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST.jobType, mediaSubtitle.handle);
        builder.registerManifest(MEDIA_VIDEO_RENDER_V1_MANIFEST);
        builder.bindHandler(MEDIA_VIDEO_RENDER_V1_MANIFEST.jobType, videoRender.handle);

        return builder.freeze({ requireHandlersForQueues: config.get("queues", { infer: true }) });
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
