import { Module } from "@nestjs/common";
import { PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import { PublishingDispatchQueueService } from "./publishing-dispatch-queue.service";
import { PublishingDispatchService } from "./publishing-dispatch.service";
import { PublishingExecutionService } from "./publishing-execution.service";
import { PublishingMediaReaderService } from "./publishing-media-reader.service";
import { PublishingProviderRegistryModule } from "./publishing-provider-registry.module";
import { PublishingProviderResolverService } from "./publishing-provider-resolver.service";
import { PublishingReadinessService } from "./publishing-readiness.service";

/**
 * Module 9 Phase 9.3 — this worker process's own Publishing wiring:
 * thin adapters over `@myev/shared`'s publishing core (crypto/resolver/
 * readiness), the execution-orchestration service, and the scheduled-
 * dispatch service. Mirrors apps/api's own PublishingModule in spirit —
 * same services by name, same shared-core dependency — but is a fully
 * separate DI registration (Module 1F's own firm process boundary).
 */
@Module({
  imports: [PublishingProviderRegistryModule],
  providers: [
    PublishingCredentialCryptoService,
    PublishingProviderResolverService,
    PublishingReadinessService,
    PublishingMediaReaderService,
    PublishingExecutionService,
    PublishingDispatchQueueService,
    PublishingDispatchService,
  ],
  exports: [PublishingCredentialCryptoService, PublishingProviderResolverService, PublishingReadinessService, PublishingExecutionService, PublishingDispatchService],
})
export class PublishingModule {}
