import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGORITHM = "aes-256-gcm";
// AES-GCM's standard 96-bit nonce — the size Node's crypto module (and
// every other AEAD implementation) is built and tested around; using a
// non-standard length is a well-known way to weaken GCM's own security
// guarantees, so this is fixed, not configurable.
const NONCE_LENGTH_BYTES = 12;
// Bumped only if the encryption primitive itself ever changes (e.g. a
// future KMS migration) — never for an ordinary key rotation under the
// SAME primitive, which real rotation tooling (a later phase) would
// instead track as new rows continuing to use this same version while
// old rows keep decrypting under whatever version they were written with.
export const PUBLISHING_CREDENTIAL_KEY_VERSION = 1;

const PUBLISHING_CRYPTO_ERROR_CODES = {
  PUBLISHING_CREDENTIAL_ENCRYPTION_KEY_INVALID: "PUBLISHING_CREDENTIAL_ENCRYPTION_KEY_INVALID",
  PUBLISHING_CREDENTIAL_DECRYPTION_FAILED: "PUBLISHING_CREDENTIAL_DECRYPTION_FAILED",
} as const;

export class PublishingCredentialConfigurationError extends Error {
  readonly code = PUBLISHING_CRYPTO_ERROR_CODES.PUBLISHING_CREDENTIAL_ENCRYPTION_KEY_INVALID;
}

export class PublishingCredentialDecryptionError extends Error {
  readonly code = PUBLISHING_CRYPTO_ERROR_CODES.PUBLISHING_CREDENTIAL_DECRYPTION_FAILED;
}

export interface EncryptedCredential {
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: number;
}

/** Validates the raw hex key string — shared by encrypt/decrypt so both fail identically on a missing/malformed key. Never called at module load or any constructor; always at the point of actual use. */
function parseKey(hexKey: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new PublishingCredentialConfigurationError(
      "The publishing credential encryption key is missing or malformed — it must be a 64-character hex string (32 random bytes) to perform channel-credential encryption.",
    );
  }
  return Buffer.from(hexKey, "hex");
}

/**
 * Module 9 Phase 9.1/9.3 — the pure AES-256-GCM envelope-encryption
 * algorithm, extracted to `@myev/shared` in Phase 9.3 Milestone A so
 * apps/api and apps/worker encrypt/decrypt channel credentials
 * identically. Authenticated encryption (never plain AES-CBC): a random
 * nonce per call, the resulting auth tag persisted alongside the
 * ciphertext (tamper detection is GCM's own built-in guarantee — a
 * flipped byte anywhere in ciphertext or authTag makes decrypt() throw,
 * never silently return corrupted plaintext).
 *
 * The raw key string is a caller-supplied parameter, never read from
 * config/env here — each process's own thin wrapper resolves it from its
 * own ConfigService (apps/api) or its own config/env reading
 * (apps/worker) and passes the resulting string in. This keeps this file
 * free of any NestJS/ConfigService dependency.
 */
export function encryptPublishingCredential(secretPayload: Record<string, unknown>, hexKey: string): EncryptedCredential {
  const key = parseKey(hexKey);
  const nonce = randomBytes(NONCE_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const plaintext = Buffer.from(JSON.stringify(secretPayload), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: PUBLISHING_CREDENTIAL_KEY_VERSION,
  };
}

export function decryptPublishingCredential(record: EncryptedCredential, hexKey: string): Record<string, unknown> {
  const key = parseKey(hexKey);
  if (record.keyVersion !== PUBLISHING_CREDENTIAL_KEY_VERSION) {
    throw new PublishingCredentialDecryptionError(`Unsupported credential key version ${record.keyVersion} (expected ${PUBLISHING_CREDENTIAL_KEY_VERSION}).`);
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
