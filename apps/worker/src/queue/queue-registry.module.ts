import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import {
  AI_EXECUTE_V1_MANIFEST,
  MEDIA_IMAGE_GENERATE_V1_MANIFEST,
  MEDIA_SUBTITLE_GENERATE_V1_MANIFEST,
  MEDIA_TTS_V1_MANIFEST,
  QueueRegistryBuilder,
  SYSTEM_PING_V1_MANIFEST,
  type QueueRegistry,
} from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { AiProviderRegistryModule } from "../ai-provider/ai-provider-registry.module";
import { AgentRegistryModule } from "../ai-provider/agent-registry.module";
import { MediaProviderRegistryModule } from "../media-provider/media-provider-registry.module";
import { MediaModule } from "../media/media.module";
import { AiExecuteProcessor } from "./processors/ai-execute.processor";
import { SystemPingProcessor } from "./processors/system-ping.processor";
import { MediaImageGenerateProcessor } from "./processors/media-image-generate.processor";
import { MediaTtsProcessor } from "./processors/media-tts.processor";
import { MediaSubtitleGenerateProcessor } from "./processors/media-subtitle-generate.processor";

export const QUEUE_REGISTRY = Symbol("QUEUE_REGISTRY");

/**
 * Builds and freezes this process's QueueRegistry at Nest DI construction
 * time — a validation failure (missing handler, duplicate manifest, …)
 * throws before the application context finishes starting.
 *
 * Every job type this worker can execute must be registered AND bound
 * here. The bijection is scoped to this instance's WORKER_QUEUES
 * selection (config.queues) — a worker that does not run the MEDIA queue
 * still holds the media.* manifests (so it can enqueue) but is not
 * required to bind their handlers.
 */
@Global()
@Module({
  imports: [ConfigModule, AiProviderRegistryModule, AgentRegistryModule, MediaProviderRegistryModule, MediaModule],
  providers: [
    SystemPingProcessor,
    AiExecuteProcessor,
    MediaImageGenerateProcessor,
    MediaTtsProcessor,
    MediaSubtitleGenerateProcessor,
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService, SystemPingProcessor, AiExecuteProcessor, MediaImageGenerateProcessor, MediaTtsProcessor, MediaSubtitleGenerateProcessor],
      useFactory: (
        config: ConfigService<WorkerConfig, true>,
        systemPing: SystemPingProcessor,
        aiExecute: AiExecuteProcessor,
        mediaImage: MediaImageGenerateProcessor,
        mediaTts: MediaTtsProcessor,
        mediaSubtitle: MediaSubtitleGenerateProcessor,
      ): QueueRegistry => {
        const builder = new QueueRegistryBuilder();

        builder.registerManifest(SYSTEM_PING_V1_MANIFEST);
        builder.bindHandler(SYSTEM_PING_V1_MANIFEST.jobType, systemPing.handle);

        builder.registerManifest(AI_EXECUTE_V1_MANIFEST);
        builder.bindHandler(AI_EXECUTE_V1_MANIFEST.jobType, aiExecute.handle);

        // Module 7 Phase 7.4 — the MEDIA-queue job families. Registered
        // always; handlers bound always (the freeze bijection only
        // *requires* them for a worker whose queue scope includes MEDIA).
        builder.registerManifest(MEDIA_IMAGE_GENERATE_V1_MANIFEST);
        builder.bindHandler(MEDIA_IMAGE_GENERATE_V1_MANIFEST.jobType, mediaImage.handle);
        builder.registerManifest(MEDIA_TTS_V1_MANIFEST);
        builder.bindHandler(MEDIA_TTS_V1_MANIFEST.jobType, mediaTts.handle);
        builder.registerManifest(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST);
        builder.bindHandler(MEDIA_SUBTITLE_GENERATE_V1_MANIFEST.jobType, mediaSubtitle.handle);

        return builder.freeze({ requireHandlersForQueues: config.get("queues", { infer: true }) });
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
