import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AI_EXECUTE_V1_MANIFEST, PUBLISHING_DISPATCH_V1_MANIFEST, PUBLISHING_EXECUTE_V1_MANIFEST, QueueRegistryBuilder, SYSTEM_PING_V1_MANIFEST, type QueueRegistry } from "@myev/shared";
import { QUEUE_REGISTRY } from "@myev/worker-core";
import type { WorkerConfig } from "../config/configuration";
import { AiProviderRegistryModule } from "../ai-provider/ai-provider-registry.module";
import { AgentRegistryModule } from "../ai-provider/agent-registry.module";
import { PublishingModule } from "../publishing/publishing.module";
import { AiExecuteProcessor } from "./processors/ai-execute.processor";
import { PublishingDispatchProcessor } from "./processors/publishing-dispatch.processor";
import { PublishingExecuteProcessor } from "./processors/publishing-execute.processor";
import { SystemPingProcessor } from "./processors/system-ping.processor";

export { QUEUE_REGISTRY };

/**
 * The general worker's QueueRegistry — SYSTEM + AI + PUBLISHING (Module 9
 * Phase 9.3 — the PUBLISHING queue name has existed since Module 1F but
 * was unclaimed by any processor until now). It does NOT register or
 * bind any MEDIA manifest (image / voice / subtitle / video render):
 * those are owned exclusively by `apps/render-worker` (frozen
 * "MEDIA = dedicated isolated workers"; checkpoint §27). A MEDIA job can
 * never reach this process because it never opens a BullMQ worker on the
 * MEDIA queue. render-worker's own queue ownership is unchanged by this
 * addition.
 */
@Global()
@Module({
  imports: [ConfigModule, AiProviderRegistryModule, AgentRegistryModule, PublishingModule],
  providers: [
    SystemPingProcessor,
    AiExecuteProcessor,
    PublishingExecuteProcessor,
    PublishingDispatchProcessor,
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService, SystemPingProcessor, AiExecuteProcessor, PublishingExecuteProcessor, PublishingDispatchProcessor],
      useFactory: (
        config: ConfigService<WorkerConfig, true>,
        systemPing: SystemPingProcessor,
        aiExecute: AiExecuteProcessor,
        publishingExecute: PublishingExecuteProcessor,
        publishingDispatch: PublishingDispatchProcessor,
      ): QueueRegistry => {
        const builder = new QueueRegistryBuilder();

        builder.registerManifest(SYSTEM_PING_V1_MANIFEST);
        builder.bindHandler(SYSTEM_PING_V1_MANIFEST.jobType, systemPing.handle);

        builder.registerManifest(AI_EXECUTE_V1_MANIFEST);
        builder.bindHandler(AI_EXECUTE_V1_MANIFEST.jobType, aiExecute.handle);

        builder.registerManifest(PUBLISHING_EXECUTE_V1_MANIFEST);
        builder.bindHandler(PUBLISHING_EXECUTE_V1_MANIFEST.jobType, publishingExecute.handle);

        builder.registerManifest(PUBLISHING_DISPATCH_V1_MANIFEST);
        builder.bindHandler(PUBLISHING_DISPATCH_V1_MANIFEST.jobType, publishingDispatch.handle);

        return builder.freeze({ requireHandlersForQueues: config.get("queues", { infer: true }) });
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
