import { PasswordPolicyService, PasswordPolicyViolationError } from "./password-policy.service";

describe("PasswordPolicyService", () => {
  const service = new PasswordPolicyService();

  it("accepts a password of exactly 12 characters", () => {
    expect(() => service.assertValid("123456789012")).not.toThrow();
  });

  it("accepts a longer password", () => {
    expect(() => service.assertValid("a-perfectly-reasonable-passphrase")).not.toThrow();
  });

  it("rejects a password shorter than 12 characters", () => {
    expect(() => service.assertValid("short1234567".slice(0, 11))).toThrow(PasswordPolicyViolationError);
  });

  it("rejects an empty password", () => {
    expect(() => service.assertValid("")).toThrow(PasswordPolicyViolationError);
  });
});
