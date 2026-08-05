import type { EmailTemplateId, EmailTemplateVariables } from "./email-provider.interface";

interface RenderedEmail {
  subject: string;
  text: string;
}

export function renderTemplate<T extends EmailTemplateId>(
  templateId: T,
  variables: EmailTemplateVariables[T],
): RenderedEmail {
  switch (templateId) {
    case "PASSWORD_RESET": {
      const v = variables as EmailTemplateVariables["PASSWORD_RESET"];
      return {
        subject: "Reset your MYEV Media password",
        text:
          `Hi ${v.recipientName},\n\n` +
          `We received a request to reset your password. This link expires in ${v.expiresInMinutes} minutes ` +
          `and can only be used once:\n\n${v.resetUrl}\n\n` +
          `If you didn't request this, you can safely ignore this email.`,
      };
    }
    case "ACCOUNT_ACTIVATION": {
      const v = variables as EmailTemplateVariables["ACCOUNT_ACTIVATION"];
      return {
        subject: "Activate your MYEV Media account",
        text:
          `Hi ${v.recipientName},\n\n` +
          `An account has been created for you. Set your password to activate it — this link expires in ` +
          `${v.expiresInMinutes} minutes:\n\n${v.activationUrl}`,
      };
    }
    default: {
      const exhaustiveCheck: never = templateId;
      throw new Error(`Unknown email template: ${exhaustiveCheck as string}`);
    }
  }
}
