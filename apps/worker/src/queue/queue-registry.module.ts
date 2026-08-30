import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AI_EXECUTE_V1_MANIFEST, QueueRegistryBuilder, SYSTEM_PING_V1_MANIFEST, type QueueRegistry } from "@myev/shared";
import { QUEUE_REGISTRY } from "@myev/worker-core";
import type { WorkerConfig } from "../config/configuration";
import { AiProviderRegistryModule } from "../ai-provider/ai-provider-registry.module";
import { AgentRegistryModule } from "../ai-provider/agent-registry.module";
import { AiExecuteProcessor } from "./processors/ai-execute.processor";
import { SystemPingProcessor } from "./processors/system-ping.processor";

export { QUEUE_REGISTRY };

/**
 * The general worker's QueueRegistry — SYSTEM + AI only. It does NOT
 * register or bind any MEDIA manifest (image / voice / subtitle / video
 * render): those are owned exclusively by `apps/render-worker` (frozen
 * "MEDIA = dedicated isolated workers"; checkpoint §27). A MEDIA job can
 * never reach this process because it never opens a BullMQ worker on the
 * MEDIA queue.
 */
@Global()
@Module({
  imports: [ConfigModule, AiProviderRegistryModule, AgentRegistryModule],
  providers: [
    SystemPingProcessor,
    AiExecuteProcessor,
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService, SystemPingProcessor, AiExecuteProcessor],
      useFactory: (config: ConfigService<WorkerConfig, true>, systemPing: SystemPingProcessor, aiExecute: AiExecuteProcessor): QueueRegistry => {
        const builder = new QueueRegistryBuilder();

        builder.registerManifest(SYSTEM_PING_V1_MANIFEST);
        builder.bindHandler(SYSTEM_PING_V1_MANIFEST.jobType, systemPing.handle);

        builder.registerManifest(AI_EXECUTE_V1_MANIFEST);
        builder.bindHandler(AI_EXECUTE_V1_MANIFEST.jobType, aiExecute.handle);

        return builder.freeze({ requireHandlersForQueues: config.get("queues", { infer: true }) });
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
