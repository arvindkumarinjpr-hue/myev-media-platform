import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decryptPublishingCredential, encryptPublishingCredential, type EncryptedCredential } from "@myev/shared";
import type { AppConfig } from "../../config/configuration";

export { PublishingCredentialConfigurationError, PublishingCredentialDecryptionError, type EncryptedCredential } from "@myev/shared";

/**
 * Module 9 Phase 9.1/9.3 — thin apps/api adapter over `@myev/shared`'s
 * pure AES-256-GCM primitive (Phase 9.3 Milestone A extraction). This
 * class's only remaining job is resolving the raw key string from
 * apps/api's own ConfigService and delegating; the algorithm itself
 * (nonce/authTag/tamper-detection/keyVersion) lives once, shared with
 * apps/worker's own equivalent thin wrapper.
 *
 * The master key is validated lazily, inside encrypt()/decrypt()
 * themselves, never in the constructor — mirroring this codebase's own
 * established "an absent AI provider key never crashes platform
 * startup" convention (configuration.ts's own ai.* doc comment) exactly.
 */
@Injectable()
export class PublishingCredentialCryptoService {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  private resolveKey(): string {
    return this.config.get("publishing", { infer: true }).credentialEncryptionKey;
  }

  encrypt(secretPayload: Record<string, unknown>): EncryptedCredential {
    return encryptPublishingCredential(secretPayload, this.resolveKey());
  }

  decrypt(record: EncryptedCredential): Record<string, unknown> {
    return decryptPublishingCredential(record, this.resolveKey());
  }
}
