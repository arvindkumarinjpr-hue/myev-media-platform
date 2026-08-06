import { assertValidCurrency, assertValidLocale, assertValidTimezone } from "./settings-validation.util";

describe("assertValidTimezone", () => {
  it("accepts real IANA timezone identifiers", () => {
    expect(() => assertValidTimezone("UTC")).not.toThrow();
    expect(() => assertValidTimezone("Asia/Kolkata")).not.toThrow();
    expect(() => assertValidTimezone("America/New_York")).not.toThrow();
  });

  it("rejects a made-up timezone", () => {
    expect(() => assertValidTimezone("Not/A/Real/Zone")).toThrow(/INVALID_TIMEZONE|not a valid IANA timezone/i);
  });
});

describe("assertValidLocale", () => {
  it("accepts common BCP-47 locale shapes", () => {
    expect(() => assertValidLocale("en-US")).not.toThrow();
    expect(() => assertValidLocale("en")).not.toThrow();
    expect(() => assertValidLocale("zh-Hans-CN")).not.toThrow();
  });

  it("rejects an obviously malformed locale", () => {
    expect(() => assertValidLocale("not a locale!!")).toThrow();
  });
});

describe("assertValidCurrency", () => {
  it("accepts three-letter uppercase ISO 4217 codes", () => {
    expect(() => assertValidCurrency("USD")).not.toThrow();
    expect(() => assertValidCurrency("INR")).not.toThrow();
  });

  it("rejects lowercase or wrong-length values", () => {
    expect(() => assertValidCurrency("usd")).toThrow();
    expect(() => assertValidCurrency("US")).toThrow();
    expect(() => assertValidCurrency("DOLLAR")).toThrow();
  });
});
