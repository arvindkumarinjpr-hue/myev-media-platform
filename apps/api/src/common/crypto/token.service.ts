import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";

/**
 * Random opaque tokens (refresh tokens, password-reset/activation tokens)
 * are generated here and only ever persisted as a SHA-256 hash — the
 * plaintext is returned once to the caller (to send to the client / email)
 * and never stored. Same pattern for both token families, per the Module
 * 1B.1 Engineering Plan.
 */
@Injectable()
export class TokenService {
  generateOpaqueToken(): string {
    return randomBytes(32).toString("base64url");
  }

  hashToken(plaintext: string): string {
    return createHash("sha256").update(plaintext).digest("hex");
  }
}
