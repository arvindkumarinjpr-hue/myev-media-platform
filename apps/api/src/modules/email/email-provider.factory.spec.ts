import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { createEmailProvider } from "./email-provider.factory";
import { MailpitEmailProvider } from "./mailpit-email.provider";
import { SmtpEmailProvider } from "./smtp-email.provider";

jest.mock("nodemailer", () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn() })) }));

function makeConfig(smtp: Partial<AppConfig["smtp"]>): ConfigService<AppConfig, true> {
  const full: AppConfig["smtp"] = {
    provider: "mailpit",
    host: "mailpit",
    port: 1025,
    fromAddress: "no-reply@myevmedia.com",
    secure: false,
    ...smtp,
  };
  return { get: () => full } as unknown as ConfigService<AppConfig, true>;
}

describe("createEmailProvider", () => {
  it("selects MailpitEmailProvider by default (provider unset/mailpit) — local/test environments unaffected", () => {
    expect(createEmailProvider(makeConfig({ provider: "mailpit" }))).toBeInstanceOf(MailpitEmailProvider);
  });

  it("selects SmtpEmailProvider when smtp.provider is 'smtp'", () => {
    expect(createEmailProvider(makeConfig({ provider: "smtp", user: "noreply@evspine.com", password: "x", secure: true }))).toBeInstanceOf(
      SmtpEmailProvider,
    );
  });
});
