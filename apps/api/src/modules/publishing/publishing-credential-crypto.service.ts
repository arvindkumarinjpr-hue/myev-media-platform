import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import { PUBLISHING_ERRORS } from "./publishing.errors";

const ALGORITHM = "aes-256-gcm";
// AES-GCM's standard 96-bit nonce — the size Node's crypto module (and
// every other AEAD implementation) is built and tested around; using a
// non-standard length is a well-known way to weaken GCM's own security
// guarantees, so this is fixed, not configurable.
const NONCE_LENGTH_BYTES = 12;
// Bumped only if the encryption primitive itself ever changes (e.g. a
// future KMS migration per the Architecture Checkpoint's own "KMS
// remains future hardening" note) — never for an ordinary key rotation
// under the SAME primitive, which real rotation tooling (a later phase)
// would instead track as new rows continuing to use this same version
// while old rows keep decrypting under whatever version they were
// written with.
const KEY_VERSION = 1;

export class PublishingCredentialConfigurationError extends Error {
  readonly code = PUBLISHING_ERRORS.PUBLISHING_CREDENTIAL_ENCRYPTION_KEY_INVALID;
}

export class PublishingCredentialDecryptionError extends Error {
  readonly code = PUBLISHING_ERRORS.PUBLISHING_CREDENTIAL_DECRYPTION_FAILED;
}

export interface EncryptedCredential {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

/**
 * Module 9 Phase 9.1 — the one dedicated service allowed to see channel
 * credential plaintext. Nothing else in the codebase may read
 * ChannelCredential.ciphertext and expect anything but opaque bytes.
 *
 * AES-256-GCM (authenticated encryption, never plain AES-CBC): a random
 * nonce per call, the resulting auth tag persisted alongside the
 * ciphertext (tamper detection is GCM's own built-in guarantee — a
 * flipped byte anywhere in ciphertext or authTag makes decrypt() throw,
 * never silently return corrupted plaintext). One structured JSON secret
 * payload per credential (e.g. {accessToken, refreshToken, scope} for
 * OAuth, {applicationPassword} for WordPress) rather than one plaintext
 * column per token component, so a future channel needing a new token
 * field never needs a migration (Architecture Checkpoint §8/Part P).
 *
 * The master key is validated lazily, inside encrypt()/decrypt()
 * themselves, never in the constructor — mirroring this codebase's own
 * established "an absent AI provider key never crashes platform
 * startup" convention (configuration.ts's own ai.* doc comment) exactly.
 * No current code path calls either method in Phase 9.1; this service
 * exists now only because ChannelCredential cannot be safely persisted
 * by a later phase without it already existing.
 */
@Injectable()
export class PublishingCredentialCryptoService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private resolveKey(): Buffer {
    const hex = this.config.get("publishing", { infer: true }).credentialEncryptionKey;
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new PublishingCredentialConfigurationError(
        "PUBLISHING_CREDENTIAL_ENCRYPTION_KEY is missing or malformed — it must be a 64-character hex string (32 random bytes) to perform channel-credential encryption.",
      );
    }
    return Buffer.from(hex, "hex");
  }

  encrypt(secretPayload: Record<string, unknown>): EncryptedCredential {
    const key = this.resolveKey();
    const nonce = randomBytes(NONCE_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, nonce);
    const plaintext = Buffer.from(JSON.stringify(secretPayload), "utf8");
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: authTag.toString("base64"),
      keyVersion: KEY_VERSION,
    };
  }

  decrypt(record: EncryptedCredential): Record<string, unknown> {
    const key = this.resolveKey();
    if (record.keyVersion !== KEY_VERSION) {
      throw new PublishingCredentialDecryptionError(`Unsupported credential key version ${record.keyVersion} (expected ${KEY_VERSION}).`);
    }
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(record.nonce, "base64"));
      decipher.setAuthTag(Buffer.from(record.authTag, "base64"));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
      return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof PublishingCredentialDecryptionError) throw err;
      // Node's crypto module throws a generic Error on auth-tag mismatch
      // (tampered ciphertext/authTag/nonce) or on a wrong key — never
      // leaked as a raw crypto-library error, same "curated, never raw"
      // discipline as every other typed error in this codebase.
      throw new PublishingCredentialDecryptionError("Failed to decrypt channel credential — the record may be corrupted, tampered with, or encrypted under a different key.");
    }
  }
}
