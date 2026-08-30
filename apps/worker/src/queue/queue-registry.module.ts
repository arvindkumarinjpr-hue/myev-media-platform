import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  AI_EXECUTE_V1_MANIFEST,
  MEDIA_IMAGE_GENERATE_V1_MANIFEST,
  MEDIA_SUBTITLE_GENERATE_V1_MANIFEST,
  MEDIA_TTS_V1_MANIFEST,
  MEDIA_VIDEO_RENDER_V1_MANIFEST,
  QueueRegistryBuilder,
  SYSTEM_PING_V1_MANIFEST,
  type QueueRegistry,
} from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { AiProviderRegistryModule } from "../ai-provider/ai-provider-registry.module";
import { AgentRegistryModule } from "../ai-provider/agent-registry.module";
import { MediaProviderRegistryModule } from "../media-provider/media-provider-registry.module";
import { MediaModule } from "../media/media.module";
import { RenderEngineModule } from "../render/render-engine.module";
import { AiExecuteProcessor } from "./processors/ai-execute.processor";
import { SystemPingProcessor } from "./processors/system-ping.processor";
import { MediaImageGenerateProcessor } from "./processors/media-image-generate.processor";
import { MediaTtsProcessor } from "./processors/media-tts.processor";
import { MediaSubtitleGenerateProcessor } from "./processors/media-subtitle-generate.processor";
import { VideoRenderProcessor } from "./processors/video-render.processor";

export const QUEUE_REGISTRY = Symbol("QUEUE_REGISTRY");

/**
 * Builds and freezes this process's QueueRegistry at Nest DI construction
 * time — a validation failure (missing handler, duplicate manifest, …)
 * throws before the application context finishes starting.
 *
 * Every job type is REGISTERED (so any worker can enqueue). Handlers are
 * BOUND per queue scope:
 *  - SYSTEM/AI jobs: always bound.
 *  - MEDIA jobs (image / tts / subtitle / video-render): bound ONLY when
 *    this worker's WORKER_QUEUES includes MEDIA — i.e. the dedicated
 *    render/media worker. A general SYSTEM/AI worker never registers or
 *    executes the render handler (checkpoint §27), and the freeze
 *    bijection (scoped to WORKER_QUEUES) confirms it.
 */
@Global()
@Module({
  imports: [ConfigModule, AiProviderRegistryModule, AgentRegistryModule, MediaProviderRegistryModule, MediaModule, RenderEngineModule],
  providers: [
    SystemPingProcessor,
    AiExecuteProcessor,
    MediaImageGenerateProcessor,
    MediaTtsProcessor,
    MediaSubtitleGenerateProcessor,
    VideoRenderProcessor,
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService, SystemPingProcessor, AiExecuteProcessor, MediaImageGenerateProcessor, MediaTtsProcessor, MediaSubtitleGenerateProcessor, VideoRenderProcessor],
      useFactory: (
        config: ConfigService<WorkerConfig, true>,
        systemPing: SystemPingProcessor,
        aiExecute: AiExecuteProcessor,
        mediaImage: MediaImageGenerateProcessor,
        mediaTts: MediaTtsProcessor,
        mediaSubtitle: MediaSubtitleGenerateProcessor,
        videoRender: VideoRenderProcessor,
      ): QueueRegistry => {
        const builder = new QueueRegistryBuilder();
        const queues = config.get("queues", { infer: true });
        const runsMedia = queues.includes("MEDIA");

        builder.registerManifest(SYSTEM_PING_V1_MANIFEST);
        builder.bindHandler(SYSTEM_PING_V1_MANIFEST.jobType, systemPing.handle);

        builder.registerManifest(AI_EXECUTE_V1_MANIFEST);
        builder.bindHandler(AI_EXECUTE_V1_MANIFEST.jobType, aiExecute.handle);

        // MEDIA-queue job families — registered always, handlers bound
        // only for the dedicated render/media worker.
        builder.registerManifest(MEDIA_IMAGE_GENERATE_V1_MANIFEST);
        builder.registerManifest(MEDIA_TTS_V1_MANIFEST);
        builder.registerManifest(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST);
        builder.registerManifest(MEDIA_VIDEO_RENDER_V1_MANIFEST);
        if (runsMedia) {
          builder.bindHandler(MEDIA_IMAGE_GENERATE_V1_MANIFEST.jobType, mediaImage.handle);
          builder.bindHandler(MEDIA_TTS_V1_MANIFEST.jobType, mediaTts.handle);
          builder.bindHandler(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST.jobType, mediaSubtitle.handle);
          builder.bindHandler(MEDIA_VIDEO_RENDER_V1_MANIFEST.jobType, videoRender.handle);
        }

        return builder.freeze({ requireHandlersForQueues: queues });
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
