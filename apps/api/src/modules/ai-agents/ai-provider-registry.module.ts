import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { AIProviderRegistry } from "@myev/shared";
import type { AppConfig } from "../../config/configuration";
import { buildAiProviderRegistry } from "./ai-provider-client-factory";

export const AI_PROVIDER_REGISTRY = Symbol("AI_PROVIDER_REGISTRY");

/**
 * Module 3 Phase 3.2's own AIProviderRegistry, mirroring
 * QueueRegistryModule's exact @Global/useFactory/freeze-once pattern
 * (apps/api/src/modules/background-jobs/queue-registry.module.ts).
 *
 * Module 3 Phase 3.4: real OpenAI/Anthropic/Gemini providers are now
 * registered whenever their credentials are configured (see
 * ai-provider-client-factory.ts — an unconfigured provider is simply
 * skipped, never registered with an invalid client). FakeProvider stays
 * registered only outside production (`config.env !== "production"`) —
 * TEST_ECHO_AGENT_V1 and Phase 3.3's own retry/timeout/permanent-failure
 * fixture agents still need it in dev/CI, but it must never be reachable
 * in a real deployment. See ai-provider-client-factory.spec.ts for the
 * regression proof.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: AI_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>): Promise<AIProviderRegistry> =>
        buildAiProviderRegistry(configService.get("ai", { infer: true }), configService.get("env", { infer: true })),
    },
  ],
  exports: [AI_PROVIDER_REGISTRY],
})
export class AiProviderRegistryModule {}
