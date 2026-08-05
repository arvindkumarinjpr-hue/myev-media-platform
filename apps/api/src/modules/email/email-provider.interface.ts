export type EmailTemplateId = "PASSWORD_RESET" | "ACCOUNT_ACTIVATION";

export interface EmailTemplateVariables {
  PASSWORD_RESET: { recipientName: string; resetUrl: string; expiresInMinutes: number };
  ACCOUNT_ACTIVATION: { recipientName: string; activationUrl: string; expiresInMinutes: number };
}

/**
 * Provider-neutral email interface (Module 1B.1 Engineering Plan §10),
 * mirroring the same adapter pattern already established for AI providers
 * (ADR-003). Mailpit is the only implementation wired up in Module 1B.1 —
 * no production vendor is selected here.
 */
export interface EmailProvider {
  send<T extends EmailTemplateId>(to: string, templateId: T, variables: EmailTemplateVariables[T]): Promise<void>;
}

export const EMAIL_PROVIDER = Symbol("EMAIL_PROVIDER");
