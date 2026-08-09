import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { QueueRegistryBuilder, SYSTEM_PING_V1_MANIFEST, type QueueRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { SystemPingProcessor } from "./processors/system-ping.processor";

export const QUEUE_REGISTRY = Symbol("QUEUE_REGISTRY");

/**
 * Builds and freezes this process's QueueRegistry at Nest DI construction
 * time — a factory provider is resolved eagerly during
 * NestFactory.createApplicationContext(), so a validation failure here
 * (missing handler, duplicate manifest, malformed manifest, etc.) throws
 * before the application context ever finishes starting. This is the
 * "fail-fast bootstrap validation" mandated by the frozen Module 1F
 * Engineering Plan's Immutable Job Registry design.
 *
 * Every job type this worker process can execute must be registered and
 * bound here. Registering a manifest with no matching handler, or vice
 * versa, fails startup — see QueueRegistryBuilder.freeze's
 * requireHandlersForQueues, scoped to this worker's own WORKER_QUEUES
 * selection (config.queues).
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    SystemPingProcessor,
    {
      provide: QUEUE_REGISTRY,
      inject: [ConfigService, SystemPingProcessor],
      useFactory: (config: ConfigService<WorkerConfig, true>, systemPing: SystemPingProcessor): QueueRegistry => {
        const builder = new QueueRegistryBuilder();

        builder.registerManifest(SYSTEM_PING_V1_MANIFEST);
        builder.bindHandler(SYSTEM_PING_V1_MANIFEST.jobType, systemPing.handle);

        return builder.freeze({ requireHandlersForQueues: config.get("queues", { infer: true }) });
      },
    },
  ],
  exports: [QUEUE_REGISTRY],
})
export class QueueRegistryModule {}
