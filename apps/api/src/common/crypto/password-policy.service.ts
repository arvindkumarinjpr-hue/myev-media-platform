import { Injectable } from "@nestjs/common";

const MIN_LENGTH = 8;
const MAX_LENGTH = 64;

export class PasswordPolicyViolationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PasswordPolicyViolationError";
  }
}

/**
 * Module 1B.1 Engineering Plan §7 / §18 decision #3: length-based policy,
 * no forced composition rules (NIST-aligned). A common-password blocklist
 * is an explicit future enhancement, not implemented here. Range widened
 * from a bare 12-char minimum to 8-64 (NIST SP 800-63B: minimum 8, and a
 * generous but bounded maximum rather than none) — a user-approved product
 * change, not a security relaxation.
 */
@Injectable()
export class PasswordPolicyService {
  assertValid(password: string): void {
    if (password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
      throw new PasswordPolicyViolationError(`Password must be between ${MIN_LENGTH} and ${MAX_LENGTH} characters.`);
    }
  }
}
