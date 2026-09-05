import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type Transporter } from "nodemailer";
import type { AppConfig } from "../../config/configuration";
import type { EmailProvider, EmailTemplateId, EmailTemplateVariables } from "./email-provider.interface";
import { renderTemplate } from "./templates";

/**
 * Module 9 Phase 9.8 — a real authenticated SMTP EmailProvider (e.g.
 * Hostinger on staging), selected via `smtp.provider === "smtp"`
 * (EmailModule's own factory). Mirrors MailpitEmailProvider's shape
 * exactly, differing only in transport options: authenticated, TLS
 * certificate validation always on (never `rejectUnauthorized: false`),
 * and bounded connection/greeting/socket timeouts so an unreachable host
 * fails fast instead of hanging the request that triggered the email.
 *
 * Never logs the raw Nodemailer error (its `command`/`response` fields
 * can echo back SMTP protocol lines) — only a stable, sanitized category
 * derived from the error's own `code`, never the credential itself.
 */
export class SmtpEmailProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmtpEmailProviderConfigurationError";
  }
}

export class SmtpEmailProviderSendError extends Error {
  constructor(public readonly category: "AUTH_FAILED" | "CONNECTION_FAILED" | "TIMED_OUT" | "SEND_FAILED") {
    super(`SMTP send failed: ${category}`);
    this.name = "SmtpEmailProviderSendError";
  }
}

const CONNECTION_TIMEOUT_MS = 10_000;
const GREETING_TIMEOUT_MS = 10_000;
const SOCKET_TIMEOUT_MS = 20_000;

function categorizeError(error: unknown): SmtpEmailProviderSendError["category"] {
  const code = (error as { code?: string } | undefined)?.code;
  if (code === "EAUTH") return "AUTH_FAILED";
  if (code === "ETIMEDOUT" || code === "ESOCKET") return "TIMED_OUT";
  if (code === "ECONNECTION" || code === "ECONNREFUSED" || code === "EDNS") return "CONNECTION_FAILED";
  return "SEND_FAILED";
}

@Injectable()
export class SmtpEmailProvider implements EmailProvider {
  private readonly logger = new Logger(SmtpEmailProvider.name);
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const smtp = this.config.get("smtp", { infer: true });
    if (!smtp.user || !smtp.password) {
      throw new SmtpEmailProviderConfigurationError("SMTP_USER and SMTP_PASSWORD are required when EMAIL_PROVIDER=smtp.");
    }
    this.fromAddress = smtp.fromAddress;
    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: { user: smtp.user, pass: smtp.password },
      // Certificate validation is always on — never rejectUnauthorized: false.
      tls: { rejectUnauthorized: true },
      connectionTimeout: CONNECTION_TIMEOUT_MS,
      greetingTimeout: GREETING_TIMEOUT_MS,
      socketTimeout: SOCKET_TIMEOUT_MS,
      logger: false,
      debug: false,
    });
  }

  async send<T extends EmailTemplateId>(
    to: string,
    templateId: T,
    variables: EmailTemplateVariables[T],
  ): Promise<void> {
    const { subject, text } = renderTemplate(templateId, variables);
    try {
      await this.transporter.sendMail({ from: this.fromAddress, to, subject, text });
    } catch (error) {
      const category = categorizeError(error);
      this.logger.error({ event: "EMAIL_SEND_FAILED", templateId, category });
      throw new SmtpEmailProviderSendError(category);
    }
    this.logger.log({ event: "EMAIL_SENT", templateId, to });
  }
}
