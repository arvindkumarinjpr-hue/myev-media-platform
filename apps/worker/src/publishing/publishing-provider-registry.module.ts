import { Global, Module } from "@nestjs/common";
import { PublishingProviderRegistryBuilder, WordPressChannelProvider, type PublishingProviderRegistry } from "@myev/shared";

export const PUBLISHING_PROVIDER_REGISTRY = Symbol("PUBLISHING_PROVIDER_REGISTRY");

/**
 * Module 9 Phase 9.3/9.4 — this worker process's own PublishingProviderRegistry,
 * mirroring apps/api's publishing-provider-registry.factory.ts and this
 * process's own AiProviderRegistryModule precedent exactly: a separate
 * DI-container registration is unavoidable (apps/worker and apps/api
 * never share a process), but both build from the identical
 * PublishingProviderRegistryBuilder/Registry classes in `@myev/shared` —
 * no duplicated business logic, only per-process bootstrap wiring, the
 * same shape AiProviderRegistryModule/QueueRegistryModule already have
 * on both sides.
 *
 * Module 9 Phase 9.4 registers `WordPressChannelProvider` unconditionally
 * (see apps/api's own factory doc comment for why — per-workspace
 * credentials, no platform secret to gate on) with the identical
 * capabilities/behavior apps/api registers (Part T: no capability/auth-
 * parsing drift between the two processes). No other real connector
 * exists yet — no YouTube/Facebook/Instagram connector (later phases).
 * Every `resolve(channelType)` call against an unconfigured channel still
 * fails as a typed error, never a crash.
 */
export function buildPublishingProviderRegistry(): PublishingProviderRegistry {
  const builder = new PublishingProviderRegistryBuilder();
  builder.register(new WordPressChannelProvider());
  return builder.freeze();
}

@Global()
@Module({
  providers: [{ provide: PUBLISHING_PROVIDER_REGISTRY, useFactory: buildPublishingProviderRegistry }],
  exports: [PUBLISHING_PROVIDER_REGISTRY],
})
export class PublishingProviderRegistryModule {}
