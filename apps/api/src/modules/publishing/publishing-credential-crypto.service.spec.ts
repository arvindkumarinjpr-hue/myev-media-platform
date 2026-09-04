import type { ConfigService } from "@nestjs/config";
import { PublishingCredentialConfigurationError, PublishingCredentialDecryptionError, PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import type { AppConfig } from "../../config/configuration";

const VALID_KEY = "a".repeat(64); // 64 hex chars = 32 bytes, a valid AES-256 key for test purposes

function makeConfig(credentialEncryptionKey: string): ConfigService<AppConfig, true> {
  return { get: () => ({ credentialEncryptionKey }) } as unknown as ConfigService<AppConfig, true>;
}

/**
 * Module 9 Phase 9.3 Milestone A — the full AES-256-GCM algorithm
 * (round-trip, random nonce, tamper detection, wrong-key rejection,
 * malformed-record handling, keyVersion behavior) is now proven once in
 * `@myev/shared`'s own `publishing-crypto.spec.ts`. This spec proves
 * only what's left local to apps/api: that this thin wrapper correctly
 * resolves the raw key from ConfigService and delegates to the shared
 * primitive — not a re-test of the primitive itself.
 */
describe("PublishingCredentialCryptoService (apps/api adapter)", () => {
  it("resolves the key from ConfigService and round-trips a payload through the shared primitive", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const payload = { accessToken: "at-123" };
    const encrypted = service.encrypt(payload);
    expect(service.decrypt(encrypted)).toEqual(payload);
  });

  it("propagates the shared primitive's typed configuration error when ConfigService holds a malformed key", () => {
    const service = new PublishingCredentialCryptoService(makeConfig("not-a-valid-key"));
    expect(() => service.encrypt({ accessToken: "x" })).toThrow(PublishingCredentialConfigurationError);
  });

  it("propagates the shared primitive's typed decryption error on a tampered record", () => {
    const service = new PublishingCredentialCryptoService(makeConfig(VALID_KEY));
    const encrypted = service.encrypt({ accessToken: "at-123" });
    const tampered = { ...encrypted, ciphertext: Buffer.from("tampered").toString("base64") };
    expect(() => service.decrypt(tampered)).toThrow(PublishingCredentialDecryptionError);
  });
});
