import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { decryptPublishingCredential, encryptPublishingCredential, type EncryptedCredential } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";

export { PublishingCredentialConfigurationError, PublishingCredentialDecryptionError, type EncryptedCredential } from "@myev/shared";

/**
 * Module 9 Phase 9.3 — this worker process's own thin adapter over
 * `@myev/shared`'s pure AES-256-GCM primitive, mirroring apps/api's
 * identically-named service exactly. Resolves the raw key from this
 * process's own ConfigService/WorkerConfig — never shares a ConfigService
 * instance with apps/api, but calls the identical shared algorithm.
 */
@Injectable()
export class PublishingCredentialCryptoService {
  constructor(private readonly config: ConfigService<WorkerConfig, true>) {}

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
