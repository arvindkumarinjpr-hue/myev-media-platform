import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { createEmailProvider } from "./email-provider.factory";
import { EMAIL_PROVIDER } from "./email-provider.interface";

/**
 * Module 9 Phase 9.8 — mirrors AiProviderRegistryModule's own
 * useFactory/ConfigService selection pattern. See
 * email-provider.factory.ts for the actual selection logic.
 */
@Module({
  imports: [ConfigModule],
  providers: [{ provide: EMAIL_PROVIDER, inject: [ConfigService], useFactory: createEmailProvider }],
  exports: [EMAIL_PROVIDER],
})
export class EmailModule {}
