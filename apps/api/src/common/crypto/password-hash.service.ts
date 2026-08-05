import { Injectable } from "@nestjs/common";
import * as argon2 from "argon2";

/**
 * Argon2id parameters — OWASP baseline (Module 1B.1 Engineering Plan §7,
 * §18 decision #2): 19 MiB memory, time cost 2, parallelism 1.
 */
const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordHashService {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // Malformed/foreign hash — never throw out of a verification path.
      return false;
    }
  }
}
