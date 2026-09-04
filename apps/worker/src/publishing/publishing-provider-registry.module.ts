import { Global, Module } from "@nestjs/common";
import { PublishingProviderRegistryBuilder, type PublishingProviderRegistry } from "@myev/shared";

export const PUBLISHING_PROVIDER_REGISTRY = Symbol("PUBLISHING_PROVIDER_REGISTRY");

/**
 * Module 9 Phase 9.3 — this worker process's own PublishingProviderRegistry,
 * mirroring apps/api's publishing-provider-registry.factory.ts and this
 * process's own AiProviderRegistryModule precedent exactly: a separate
 * DI-container registration is unavoidable (apps/worker and apps/api
 * never share a process), but both build from the identical
 * PublishingProviderRegistryBuilder/Registry classes in `@myev/shared` —
 * no duplicated business logic, only per-process bootstrap wiring, the
 * same shape AiProviderRegistryModule/QueueRegistryModule already have
 * on both sides.
 *
 * Registers zero real channel providers today — no WordPress/YouTube/
 * Facebook/Instagram connector exists yet (later phases). Every
 * `resolve(channelType)` call against an unconfigured channel fails as a
 * typed error, never a crash.
 */
function buildPublishingProviderRegistry(): PublishingProviderRegistry {
  return new PublishingProviderRegistryBuilder().freeze();
}

@Global()
@Module({
  providers: [{ provide: PUBLISHING_PROVIDER_REGISTRY, useFactory: buildPublishingProviderRegistry }],
  exports: [PUBLISHING_PROVIDER_REGISTRY],
})
export class PublishingProviderRegistryModule {}
