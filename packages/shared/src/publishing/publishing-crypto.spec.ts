import { decryptPublishingCredential, encryptPublishingCredential, PublishingCredentialConfigurationError, PublishingCredentialDecryptionError } from "./publishing-crypto";

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes, a valid AES-256 key for test purposes

describe("publishing-crypto", () => {
  it("round-trips a structured secret payload through encrypt/decrypt", () => {
    const payload = { accessToken: "at-123", refreshToken: "rt-456", scope: "publish" };
    const encrypted = encryptPublishingCredential(payload, VALID_KEY);
    expect(decryptPublishingCredential(encrypted, VALID_KEY)).toEqual(payload);
  });

  it("encrypts the same plaintext differently on each call (random nonce)", () => {
    const payload = { accessToken: "same-value" };
    const first = encryptPublishingCredential(payload, VALID_KEY);
    const second = encryptPublishingCredential(payload, VALID_KEY);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    // Both still decrypt correctly despite differing ciphertext/nonce.
    expect(decryptPublishingCredential(first, VALID_KEY)).toEqual(payload);
    expect(decryptPublishingCredential(second, VALID_KEY)).toEqual(payload);
  });

  it("rejects a tampered ciphertext rather than returning corrupted plaintext", () => {
    const encrypted = encryptPublishingCredential({ accessToken: "at-123" }, VALID_KEY);
    const tampered = { ...encrypted, ciphertext: Buffer.from("tampered-bytes-here!").toString("base64") };
    expect(() => decryptPublishingCredential(tampered, VALID_KEY)).toThrow(PublishingCredentialDecryptionError);
  });

  it("rejects a tampered auth tag", () => {
    const encrypted = encryptPublishingCredential({ accessToken: "at-123" }, VALID_KEY);
    const tampered = { ...encrypted, authTag: Buffer.from(Array(16).fill(0)).toString("base64") };
    expect(() => decryptPublishingCredential(tampered, VALID_KEY)).toThrow(PublishingCredentialDecryptionError);
  });

  it("fails to decrypt under a different key than the one used to encrypt", () => {
    const encrypted = encryptPublishingCredential({ accessToken: "at-123" }, VALID_KEY);
    expect(() => decryptPublishingCredential(encrypted, "b".repeat(64))).toThrow(PublishingCredentialDecryptionError);
  });

  it("rejects a malformed ciphertext record safely, never throwing a raw crypto-library error", () => {
    expect(() => decryptPublishingCredential({ ciphertext: "not-valid-base64!!!", nonce: "also-bad", authTag: "bad", keyVersion: 1 }, VALID_KEY)).toThrow(PublishingCredentialDecryptionError);
  });

  it("preserves keyVersion on encrypt and rejects an unrecognized version on decrypt", () => {
    const encrypted = encryptPublishingCredential({ accessToken: "at-123" }, VALID_KEY);
    expect(encrypted.keyVersion).toBe(1);
    expect(() => decryptPublishingCredential({ ...encrypted, keyVersion: 2 }, VALID_KEY)).toThrow(PublishingCredentialDecryptionError);
  });

  it.each(["", "short", "z".repeat(64), "a".repeat(63)])("fails safely (typed error, not a crash) when the key is missing or malformed: %p", (badKey) => {
    expect(() => encryptPublishingCredential({ accessToken: "x" }, badKey)).toThrow(PublishingCredentialConfigurationError);
  });

  it("never includes the original plaintext substring anywhere in the encrypted record's serialized form", () => {
    const secretMarker = "super-secret-oauth-token-marker-xyz";
    const encrypted = encryptPublishingCredential({ accessToken: secretMarker }, VALID_KEY);
    expect(JSON.stringify(encrypted)).not.toContain(secretMarker);
  });
});
