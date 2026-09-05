import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { AuthModule } from "../auth/auth.module";
import { BackgroundJobsModule } from "../background-jobs/background-jobs.module";
import { ContentModule } from "../content/content.module";
import { PublishingAccountHealthService } from "./publishing-account-health.service";
import { PublishingAccountsController } from "./publishing-accounts.controller";
import { PublishingAccountsService } from "./publishing-accounts.service";
import { PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import { PublishingDispatchService } from "./publishing-dispatch.service";
import { PublishingOAuthCallbackController, PublishingOAuthStartController } from "./publishing-oauth.controller";
import { PublishingOAuthService } from "./publishing-oauth.service";
import { PublishingOAuthStateService } from "./publishing-oauth-state.service";
import { PublishingPersistenceService } from "./publishing-persistence.service";
import { PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PUBLISHING_PROVIDER_REGISTRY, buildPublishingProviderRegistry } from "./publishing-provider-registry.factory";
import { PublishingPublicationsController } from "./publishing-publications.controller";
import { PublishingQueryService } from "./publishing-query.service";
import { PublishingReadinessService } from "./publishing-readiness.service";
import { PublishingReconciliationService } from "./publishing-reconciliation.service";

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain +
 * persistence foundation. Phase 9.2 adds the provider abstraction
 * (registry/resolver) and PublishingReadinessService. Phase 9.3 adds
 * PublishingDispatchService. Phase 9.4/9.5/9.6 add the four real
 * connectors. Phase 9.7 adds the first HTTP controllers: account
 * management (WordPress connect, YouTube/Meta OAuth, health/disconnect),
 * the Publication API (create/readiness/list/detail/retry/cancel/safe
 * attempt history), and manual reconciliation. AuditModule is
 * `@Global()` — no explicit import needed, same as every other module
 * that injects AuditService.
 *
 * Phase 9.8 staging UAT defect fix — ContentModule import: Publishing's
 * "select content" step needs "every APPROVED Blog/Video content item",
 * a different question from Blog's/Video's own list() ("items that went
 * through MY pipeline"). Reusing BlogService.list()/videoApi.list()
 * silently excluded real Approved content that never had Module 6/7
 * pipeline metadata (e.g. Module 8's own UAT fixture blogs) — see
 * PublishingQueryService.listPublishableContent(), which queries
 * ContentItemsService.list() directly instead.
 *
 * PUBLISHING_PROVIDER_REGISTRY defaults to the real production registry
 * — never the fixture provider. E2E tests override it via NestJS's own
 * overrideProvider, the identical pattern RESEARCH_SOURCE_PROVIDER/
 * AiProviderRegistryModule already established.
 */
@Module({
  imports: [BackgroundJobsModule, ConfigModule, AuthModule, ContentModule],
  controllers: [PublishingAccountsController, PublishingOAuthStartController, PublishingOAuthCallbackController, PublishingPublicationsController],
  providers: [
    PublishingCredentialCryptoService,
    PublishingPersistenceService,
    PublishingProviderResolverService,
    PublishingReadinessService,
    PublishingDispatchService,
    PublishingAccountHealthService,
    PublishingAccountsService,
    PublishingOAuthStateService,
    PublishingOAuthService,
    PublishingReconciliationService,
    PublishingQueryService,
    {
      provide: PUBLISHING_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (configService: ConfigService<AppConfig, true>) => {
        const publishing = configService.get("publishing", { infer: true });
        return buildPublishingProviderRegistry(publishing.youtube, publishing.meta);
      },
    },
  ],
  exports: [
    PublishingCredentialCryptoService,
    PublishingPersistenceService,
    PublishingProviderResolverService,
    PublishingReadinessService,
    PublishingDispatchService,
    PublishingAccountHealthService,
    PublishingAccountsService,
    PublishingReconciliationService,
    PublishingQueryService,
    PUBLISHING_PROVIDER_REGISTRY,
  ],
})
export class PublishingModule {}
