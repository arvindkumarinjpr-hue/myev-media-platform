import { PasswordPolicyService, PasswordPolicyViolationError } from "./password-policy.service";

describe("PasswordPolicyService", () => {
  const service = new PasswordPolicyService();

  it("accepts a password of exactly 8 characters — the policy's minimum boundary", () => {
    expect(() => service.assertValid("12345678")).not.toThrow();
  });

  it("accepts a password of exactly 64 characters — the policy's maximum boundary", () => {
    expect(() => service.assertValid("a".repeat(64))).not.toThrow();
  });

  it("accepts a mid-range password", () => {
    expect(() => service.assertValid("a-perfectly-reasonable-passphrase")).not.toThrow();
  });

  it("rejects a password shorter than 8 characters (7 characters)", () => {
    expect(() => service.assertValid("1234567")).toThrow(PasswordPolicyViolationError);
  });

  it("rejects a password longer than 64 characters (65 characters)", () => {
    expect(() => service.assertValid("a".repeat(65))).toThrow(PasswordPolicyViolationError);
  });

  it("rejects an empty password", () => {
    expect(() => service.assertValid("")).toThrow(PasswordPolicyViolationError);
  });

  it("uses a single consistent message for both bounds — no separate 'too short'/'too long' wording", () => {
    expect(() => service.assertValid("1234567")).toThrow("Password must be between 8 and 64 characters.");
    expect(() => service.assertValid("a".repeat(65))).toThrow("Password must be between 8 and 64 characters.");
  });
});
