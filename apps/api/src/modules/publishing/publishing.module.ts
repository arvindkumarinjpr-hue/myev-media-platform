import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { BackgroundJobsModule } from "../background-jobs/background-jobs.module";
import { PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import { PublishingDispatchService } from "./publishing-dispatch.service";
import { PublishingPersistenceService } from "./publishing-persistence.service";
import { PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PUBLISHING_PROVIDER_REGISTRY, buildPublishingProviderRegistry } from "./publishing-provider-registry.factory";
import { PublishingReadinessService } from "./publishing-readiness.service";

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain +
 * persistence foundation. Phase 9.2 adds the provider abstraction
 * (registry/resolver) and PublishingReadinessService. Phase 9.3 adds
 * PublishingDispatchService (manual dispatch + cancel, reusing
 * BackgroundJobsService.enqueue()) and — inside
 * PublishingPersistenceService.createPublication() — ScheduledJob
 * creation for a Publication with `scheduledFor` set.
 *
 * Still no controller (no publish-now/scheduling HTTP API exists yet —
 * PUBLISH_EXECUTE will gate a future one). No real provider connectors
 * (the registry factory registers zero channels this phase), no OAuth
 * flow. AuditModule is `@Global()` — no explicit import needed, same as
 * every other module that injects AuditService.
 *
 * PUBLISHING_PROVIDER_REGISTRY defaults to the real (currently empty)
 * production registry — never the fixture provider. E2E tests override
 * it via NestJS's own overrideProvider, the identical pattern
 * RESEARCH_SOURCE_PROVIDER/AiProviderRegistryModule already established.
 */
@Module({
  imports: [BackgroundJobsModule, ConfigModule],
  providers: [
    PublishingCredentialCryptoService,
    PublishingPersistenceService,
    PublishingProviderResolverService,
    PublishingReadinessService,
    PublishingDispatchService,
    {
      provide: PUBLISHING_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => buildPublishingProviderRegistry(configService.get("publishing", { infer: true }).youtube),
    },
  ],
  exports: [PublishingCredentialCryptoService, PublishingPersistenceService, PublishingProviderResolverService, PublishingReadinessService, PublishingDispatchService, PUBLISHING_PROVIDER_REGISTRY],
})
export class PublishingModule {}
