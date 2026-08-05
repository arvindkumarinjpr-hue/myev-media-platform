import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type Transporter } from "nodemailer";
import type { AppConfig } from "../../config/configuration";
import type { EmailProvider, EmailTemplateId, EmailTemplateVariables } from "./email-provider.interface";
import { renderTemplate } from "./templates";

/**
 * Local-development EmailProvider implementation — sends via SMTP to
 * Mailpit (captured, never actually delivered). No production vendor is
 * selected in Module 1B.1 (Engineering Plan §10) — a future provider only
 * needs to implement the same EmailProvider interface.
 */
@Injectable()
export class MailpitEmailProvider implements EmailProvider {
  private readonly logger = new Logger(MailpitEmailProvider.name);
  private readonly transporter: Transporter;
  private readonly fromAddress: string;

  constructor(private readonly config: ConfigService<AppConfig, true>) {
    const smtp = this.config.get("smtp", { infer: true });
    this.fromAddress = smtp.fromAddress;
    this.transporter = createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: false,
      ignoreTLS: true,
    });
  }

  async send<T extends EmailTemplateId>(
    to: string,
    templateId: T,
    variables: EmailTemplateVariables[T],
  ): Promise<void> {
    const { subject, text } = renderTemplate(templateId, variables);
    await this.transporter.sendMail({ from: this.fromAddress, to, subject, text });
    this.logger.log({ event: "EMAIL_SENT", templateId, to });
  }
}
