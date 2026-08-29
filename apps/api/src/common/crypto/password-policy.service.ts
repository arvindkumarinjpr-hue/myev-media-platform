import { Injectable } from "@nestjs/common";

const MIN_LENGTH = 8;

export class PasswordPolicyViolationError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PasswordPolicyViolationError";
  }
}

/**
 * Module 1B.1 Engineering Plan §7 / §18 decision #3: length-based policy,
 * no forced composition rules (NIST-aligned). A common-password blocklist
 * is an explicit future enhancement, not implemented here.
 */
@Injectable()
export class PasswordPolicyService {
  assertValid(password: string): void {
    if (password.length < MIN_LENGTH) {
      throw new PasswordPolicyViolationError(`Password must be at least ${MIN_LENGTH} characters.`);
    }
  }
}
