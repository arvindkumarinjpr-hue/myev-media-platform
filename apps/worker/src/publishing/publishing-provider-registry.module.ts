import { Global, Logger, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { PublishingProviderRegistryBuilder, WordPressChannelProvider, YouTubeChannelProvider, type PublishingProviderRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";

export const PUBLISHING_PROVIDER_REGISTRY = Symbol("PUBLISHING_PROVIDER_REGISTRY");

const logger = new Logger("PublishingProviderRegistryModule");

/**
 * Module 9 Phase 9.3/9.4/9.5 — this worker process's own PublishingProviderRegistry,
 * mirroring apps/api's publishing-provider-registry.factory.ts and this
 * process's own AiProviderRegistryModule precedent exactly: a separate
 * DI-container registration is unavoidable (apps/worker and apps/api
 * never share a process), but both build from the identical
 * PublishingProviderRegistryBuilder/Registry classes in `@myev/shared` —
 * no duplicated business logic, only per-process bootstrap wiring, the
 * same shape AiProviderRegistryModule/QueueRegistryModule already have
 * on both sides.
 *
 * Module 9 Phase 9.4 registered `WordPressChannelProvider` unconditionally
 * (see apps/api's own factory doc comment for why — per-workspace
 * credentials, no platform secret to gate on). Module 9 Phase 9.5 adds
 * `YouTubeChannelProvider`, gated behind the platform's own Google OAuth
 * client id/secret exactly like apps/api's own factory (see its doc
 * comment) — identical capabilities/behavior apps/api registers (Part T:
 * no capability/auth-parsing drift between the two processes). No other
 * real connector exists yet — no Facebook/Instagram connector (later
 * phases). Every `resolve(channelType)` call against an unconfigured
 * channel still fails as a typed error, never a crash.
 */
export function buildPublishingProviderRegistry(youtube: { oauthClientId: string; oauthClientSecret: string }): PublishingProviderRegistry {
  const builder = new PublishingProviderRegistryBuilder();
  builder.register(new WordPressChannelProvider());

  if (youtube.oauthClientId && youtube.oauthClientSecret) {
    builder.register(new YouTubeChannelProvider({ oauthClientId: youtube.oauthClientId, oauthClientSecret: youtube.oauthClientSecret }));
    logger.log("YouTube provider configured.");
  } else {
    logger.warn("YouTube provider not configured — YOUTUBE_OAUTH_CLIENT_ID/YOUTUBE_OAUTH_CLIENT_SECRET are not set.");
  }

  return builder.freeze();
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: PUBLISHING_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<WorkerConfig, true>) => buildPublishingProviderRegistry(configService.get("publishing", { infer: true }).youtube),
    },
  ],
  exports: [PUBLISHING_PROVIDER_REGISTRY],
})
export class PublishingProviderRegistryModule {}
