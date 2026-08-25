import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { AIProviderRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { buildAiProviderRegistry } from "./ai-provider-client-factory";

export const AI_PROVIDER_REGISTRY = Symbol("AI_PROVIDER_REGISTRY");

/**
 * Module 3 Phase 3.3 — this worker process's own AIProviderRegistry,
 * mirroring apps/api's AiProviderRegistryModule exactly (same
 * @Global/useFactory/freeze-once pattern already established for
 * QueueRegistryModule on both processes). A separate DI-container
 * registration is unavoidable — apps/worker and apps/api are separate
 * NestJS processes and neither imports the other's compiled providers
 * (Module 1F's own firm boundary: apps/api never executes jobs, only
 * apps/worker does) — but both processes register the identical
 * packages/shared building blocks, so there is no duplicated business
 * logic, only DI bootstrap wiring, the same shape QueueRegistryModule
 * itself already has on both sides.
 *
 * Module 3 Phase 3.4: real providers are registered whenever configured
 * (see apps/api's identical module for the full rationale — this file's
 * own ai-provider-client-factory.ts is a separate copy, not a shared
 * one, for the same cross-process reason everything else here is
 * duplicated). FakeProvider and the Phase 3.3 test fixtures stay
 * registered only outside production.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: AI_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<WorkerConfig, true>): Promise<AIProviderRegistry> =>
        buildAiProviderRegistry(configService.get("ai", { infer: true }), configService.get("env", { infer: true })),
    },
  ],
  exports: [AI_PROVIDER_REGISTRY],
})
export class AiProviderRegistryModule {}
