import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import type { EmailProvider } from "./email-provider.interface";
import { MailpitEmailProvider } from "./mailpit-email.provider";
import { SmtpEmailProvider } from "./smtp-email.provider";

/**
 * Module 9 Phase 9.8 — mirrors ai-provider-client-factory.ts's own
 * standalone, directly-testable factory pattern. `smtp.provider` selects
 * the concrete implementation; local/test environments are unaffected
 * (default stays "mailpit" unless EMAIL_PROVIDER=smtp is explicitly set).
 */
export function createEmailProvider(configService: ConfigService<AppConfig, true>): EmailProvider {
  const provider = configService.get("smtp", { infer: true }).provider;
  return provider === "smtp" ? new SmtpEmailProvider(configService) : new MailpitEmailProvider(configService);
}
