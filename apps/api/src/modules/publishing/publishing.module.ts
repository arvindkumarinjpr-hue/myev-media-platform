import { Module } from "@nestjs/common";
import { PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import { PublishingPersistenceService } from "./publishing-persistence.service";

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain +
 * persistence foundation only.
 *
 * No controllers (no publish-now/scheduling API exists yet — Architecture
 * Checkpoint's own Phase 9.1 scope explicitly excludes it), no provider
 * connectors, no worker/queue wiring, no OAuth flow. AuditModule is
 * `@Global()` — no explicit import needed, same as every other module
 * that injects AuditService.
 */
@Module({
  providers: [PublishingCredentialCryptoService, PublishingPersistenceService],
  exports: [PublishingCredentialCryptoService, PublishingPersistenceService],
})
export class PublishingModule {}
