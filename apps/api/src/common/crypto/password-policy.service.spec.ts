import { PasswordPolicyService, PasswordPolicyViolationError } from "./password-policy.service";

describe("PasswordPolicyService", () => {
  const service = new PasswordPolicyService();

  it("accepts a password of exactly 8 characters", () => {
    expect(() => service.assertValid("12345678")).not.toThrow();
  });

  it("accepts a longer password", () => {
    expect(() => service.assertValid("a-perfectly-reasonable-passphrase")).not.toThrow();
  });

  it("rejects a password shorter than 8 characters (7 characters)", () => {
    expect(() => service.assertValid("1234567")).toThrow(PasswordPolicyViolationError);
  });

  it("rejects an empty password", () => {
    expect(() => service.assertValid("")).toThrow(PasswordPolicyViolationError);
  });
});
