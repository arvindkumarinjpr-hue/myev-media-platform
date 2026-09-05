import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { MailpitEmailProvider } from "./mailpit-email.provider";

const sendMail = jest.fn();
const createTransport = jest.fn((_options: Record<string, unknown>) => ({ sendMail }));

jest.mock("nodemailer", () => ({
  createTransport: (options: Record<string, unknown>) => createTransport(options),
}));

function makeConfig(): ConfigService<AppConfig, true> {
  const smtp: AppConfig["smtp"] = {
    provider: "mailpit",
    host: "mailpit",
    port: 1025,
    fromAddress: "no-reply@myevmedia.com",
    secure: false,
    user: undefined,
    password: undefined,
  };
  return { get: () => smtp } as unknown as ConfigService<AppConfig, true>;
}

describe("MailpitEmailProvider (Module 9 Phase 9.8 regression — unchanged by the new SmtpEmailProvider)", () => {
  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
  });

  it("still configures an unauthenticated, non-TLS transport (correct for a local Mailpit relay)", () => {
    new MailpitEmailProvider(makeConfig());

    const options = createTransport.mock.calls[0][0] as Record<string, unknown>;
    expect(options.host).toBe("mailpit");
    expect(options.port).toBe(1025);
    expect(options.secure).toBe(false);
    expect(options.ignoreTLS).toBe(true);
    expect(options.auth).toBeUndefined();
  });

  it("still sends using the configured From address", async () => {
    sendMail.mockResolvedValue({ messageId: "abc" });
    const provider = new MailpitEmailProvider(makeConfig());

    await provider.send("someone@example.com", "PASSWORD_RESET", { recipientName: "Someone", resetUrl: "https://x", expiresInMinutes: 60 });

    const mail = sendMail.mock.calls[0][0] as Record<string, unknown>;
    expect(mail.from).toBe("no-reply@myevmedia.com");
    expect(mail.to).toBe("someone@example.com");
  });
});
