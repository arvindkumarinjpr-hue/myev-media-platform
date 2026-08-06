import { BadRequestException } from "@nestjs/common";

const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-\d{3})?$/; // light BCP-47 shape check
const CURRENCY_PATTERN = /^[A-Z]{3}$/; // ISO 4217 shape check

/** Throws 400 if the value isn't a real IANA timezone identifier. */
export function assertValidTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new BadRequestException({ code: "INVALID_TIMEZONE", message: `"${timezone}" is not a valid IANA timezone identifier.` });
  }
}

export function assertValidLocale(locale: string): void {
  if (!LOCALE_PATTERN.test(locale)) {
    throw new BadRequestException({ code: "INVALID_LOCALE", message: `"${locale}" is not a valid locale identifier.` });
  }
}

export function assertValidCurrency(currency: string): void {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new BadRequestException({ code: "INVALID_CURRENCY", message: `"${currency}" is not a valid ISO 4217 currency code.` });
  }
}
