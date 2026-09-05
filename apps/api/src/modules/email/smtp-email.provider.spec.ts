import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { SmtpEmailProvider, SmtpEmailProviderConfigurationError, SmtpEmailProviderSendError } from "./smtp-email.provider";

const sendMail = jest.fn();
const createTransport = jest.fn((_options: Record<string, unknown>) => ({ sendMail }));

jest.mock("nodemailer", () => ({
  createTransport: (options: Record<string, unknown>) => createTransport(options),
}));

const REAL_PASSWORD = "hunter2-real-hostinger-password";

function makeConfig(overrides: Partial<AppConfig["smtp"]> = {}): ConfigService<AppConfig, true> {
  const smtp: AppConfig["smtp"] = {
    provider: "smtp",
    host: "smtp.hostinger.com",
    port: 465,
    fromAddress: "noreply@evspine.com",
    secure: true,
    user: "noreply@evspine.com",
    password: REAL_PASSWORD,
    ...overrides,
  };
  return { get: () => smtp } as unknown as ConfigService<AppConfig, true>;
}

describe("SmtpEmailProvider", () => {
  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
  });

  it("configures an authenticated transport with implicit TLS for port 465 and certificate validation always on", () => {
    new SmtpEmailProvider(makeConfig());

    expect(createTransport).toHaveBeenCalledTimes(1);
    const options = createTransport.mock.calls[0][0] as Record<string, unknown>;
    expect(options.host).toBe("smtp.hostinger.com");
    expect(options.port).toBe(465);
    expect(options.secure).toBe(true);
    expect(options.auth).toEqual({ user: "noreply@evspine.com", pass: REAL_PASSWORD });
    expect((options.tls as { rejectUnauthorized?: boolean }).rejectUnauthorized).toBe(true);
    expect(options.logger).toBe(false);
    expect(options.debug).toBe(false);
  });

  it("throws a configuration error at construction if user or password is missing — never a silent unauthenticated fallback", () => {
    expect(() => new SmtpEmailProvider(makeConfig({ user: undefined }))).toThrow(SmtpEmailProviderConfigurationError);
    expect(() => new SmtpEmailProvider(makeConfig({ password: undefined }))).toThrow(SmtpEmailProviderConfigurationError);
  });

  it("sends successfully using the configured From address", async () => {
    sendMail.mockResolvedValue({ messageId: "abc" });
    const provider = new SmtpEmailProvider(makeConfig());

    await provider.send("owner@myevmedia.com", "PASSWORD_RESET", {
      recipientName: "Owner",
      resetUrl: "https://staging.myevmedia.com/reset-password?token=x",
      expiresInMinutes: 60,
    });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(mail.from).toBe("noreply@evspine.com");
    expect(mail.to).toBe("owner@myevmedia.com");
    expect(mail.subject).toContain("Reset your MYEV Media password");
  });

  it("sanitizes an authentication failure — never leaks the raw Nodemailer error or the password", async () => {
    const rawError = Object.assign(new Error(`535 Authentication failed for user noreply@evspine.com pass ${REAL_PASSWORD}`), { code: "EAUTH" });
    sendMail.mockRejectedValue(rawError);
    const provider = new SmtpEmailProvider(makeConfig());

    let thrown: unknown;
    try {
      await provider.send("owner@myevmedia.com", "PASSWORD_RESET", { recipientName: "Owner", resetUrl: "https://x", expiresInMinutes: 60 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SmtpEmailProviderSendError);
    expect((thrown as SmtpEmailProviderSendError).category).toBe("AUTH_FAILED");
    const serialized = JSON.stringify(thrown) + String((thrown as Error).message) + String((thrown as Error).stack);
    expect(serialized).not.toContain(REAL_PASSWORD);
    expect(serialized).not.toContain(rawError.message);
  });

  it("sanitizes a network/connection failure — never leaks the raw Nodemailer error", async () => {
    const rawError = Object.assign(new Error("connect ECONNREFUSED 66.45.239.1:465"), { code: "ECONNREFUSED" });
    sendMail.mockRejectedValue(rawError);
    const provider = new SmtpEmailProvider(makeConfig());

    let thrown: unknown;
    try {
      await provider.send("owner@myevmedia.com", "PASSWORD_RESET", { recipientName: "Owner", resetUrl: "https://x", expiresInMinutes: 60 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SmtpEmailProviderSendError);
    expect((thrown as SmtpEmailProviderSendError).category).toBe("CONNECTION_FAILED");
    const serialized = JSON.stringify(thrown) + String((thrown as Error).message);
    expect(serialized).not.toContain(rawError.message);
  });

  it("never includes the password anywhere in its own constructed/thrown representations", async () => {
    sendMail.mockRejectedValue(Object.assign(new Error("boom"), { code: "ETIMEDOUT" }));
    const provider = new SmtpEmailProvider(makeConfig());
    try {
      await provider.send("owner@myevmedia.com", "PASSWORD_RESET", { recipientName: "Owner", resetUrl: "https://x", expiresInMinutes: 60 });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(REAL_PASSWORD);
      expect((error as Error).message).not.toContain(REAL_PASSWORD);
    }
  });
});
