import type { ConfigService } from "@nestjs/config";
import { PublishingCredentialConfigurationError, PublishingCredentialCryptoService, PublishingCredentialDecryptionError } from "./publishing-credential-crypto.service";
import type { AppConfig } from "../../config/configuration";

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes, a valid AES-256 key for test purposes

function makeConfig(credentialEncryptionKey: string): ConfigService<AppConfig, true> {
  return { get: () => ({ credentialEncryptionKey }) } as unknown as ConfigService<AppConfig, true>;
}

describe("PublishingCredentialCryptoService", () => {
  it("round-trips a structured secret payload through encrypt/decrypt", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const payload = { accessToken: "at-123", refreshToken: "rt-456", scope: "publish" };
    const encrypted = service.encrypt(payload);
    expect(service.decrypt(encrypted)).toEqual(payload);
  });

  it("encrypts the same plaintext differently on each call (random nonce)", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const payload = { accessToken: "same-value" };
    const first = service.encrypt(payload);
    const second = service.encrypt(payload);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    // Both still decrypt correctly despite differing ciphertext/nonce.
    expect(service.decrypt(first)).toEqual(payload);
    expect(service.decrypt(second)).toEqual(payload);
  });

  it("rejects a tampered ciphertext rather than returning corrupted plaintext", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const encrypted = service.encrypt({ accessToken: "at-123" });
    const tampered = { ...encrypted, ciphertext: Buffer.from("tampered-bytes-here!").toString("base64") };
    expect(() => service.decrypt(tampered)).toThrow(PublishingCredentialDecryptionError);
  });

  it("rejects a tampered auth tag", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const encrypted = service.encrypt({ accessToken: "at-123" });
    const tampered = { ...encrypted, authTag: Buffer.from(Array(16).fill(0)).toString("base64") };
    expect(() => service.decrypt(tampered)).toThrow(PublishingCredentialDecryptionError);
  });

  it("fails to decrypt under a different key than the one used to encrypt", () => {
    const encrypted = new PublishingCredentialCryptoService(makeConfig(VALID_KEY)).encrypt({ accessToken: "at-123" });
    const wrongKeyService = new PublishingCredentialCryptoService(makeConfig("b".repeat(64)));
    expect(() => wrongKeyService.decrypt(encrypted)).toThrow(PublishingCredentialDecryptionError);
  });

  it("rejects a malformed ciphertext record safely, never throwing a raw crypto-library error", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    expect(() => service.decrypt({ ciphertext: "not-valid-base64!!!", nonce: "also-bad", authTag: "bad", keyVersion: 1 })).toThrow(PublishingCredentialDecryptionError);
  });

  it("preserves keyVersion on encrypt and rejects an unrecognized version on decrypt", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const encrypted = service.encrypt({ accessToken: "at-123" });
    expect(encrypted.keyVersion).toBe(1);
    expect(() => service.decrypt({ ...encrypted, keyVersion: 2 })).toThrow(PublishingCredentialDecryptionError);
  });

  it.each(["", "short", "z".repeat(64), "a".repeat(63)])("fails safely (typed error, not a crash) when the key is missing or malformed: %p", (badKey) => {
    const service = new PublishingCredentialCryptoService(makeConfig(badKey));
    expect(() => service.encrypt({ accessToken: "x" })).toThrow(PublishingCredentialConfigurationError);
  });

  it("never includes the original plaintext substring anywhere in the encrypted record's serialized form", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const secretMarker = "super-secret-oauth-token-marker-xyz";
    const encrypted = service.encrypt({ accessToken: secretMarker });
    expect(JSON.stringify(encrypted)).not.toContain(secretMarker);
  });
});
