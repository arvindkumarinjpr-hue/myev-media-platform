import { Module } from "@nestjs/common";
import { PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import { PublishingPersistenceService } from "./publishing-persistence.service";
import { PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PUBLISHING_PROVIDER_REGISTRY, buildPublishingProviderRegistry } from "./publishing-provider-registry.factory";
import { PublishingReadinessService } from "./publishing-readiness.service";

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain +
 * persistence foundation. Phase 9.2 adds the provider abstraction
 * (registry/resolver) and PublishingReadinessService on top, unchanged.
 *
 * No controllers (no publish-now/scheduling API exists yet — Architecture
 * Checkpoint's own Phase 9.1 scope explicitly excludes it, and Phase
 * 9.2 does not add one either), no real provider connectors (the
 * registry factory registers zero channels this phase), no worker/queue
 * wiring, no OAuth flow. AuditModule is `@Global()` — no explicit import
 * needed, same as every other module that injects AuditService.
 *
 * PUBLISHING_PROVIDER_REGISTRY defaults to the real (currently empty)
 * production registry — never the fixture provider. E2E tests override
 * it via NestJS's own overrideProvider, the identical pattern
 * RESEARCH_SOURCE_PROVIDER/AiProviderRegistryModule already established.
 */
@Module({
  providers: [
    PublishingCredentialCryptoService,
    PublishingPersistenceService,
    PublishingProviderResolverService,
    PublishingReadinessService,
    { provide: PUBLISHING_PROVIDER_REGISTRY, useFactory: buildPublishingProviderRegistry },
  ],
  exports: [PublishingCredentialCryptoService, PublishingPersistenceService, PublishingProviderResolverService, PublishingReadinessService, PUBLISHING_PROVIDER_REGISTRY],
})
export class PublishingModule {}
