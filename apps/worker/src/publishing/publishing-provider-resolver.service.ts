import { Inject, Injectable } from "@nestjs/common";
import {
  PublishingProviderRegistryValidationError,
  type PublishingChannelProvider,
  type PublishingConnectionValidationResult,
  type PublishingExecutionCallbacks,
  type PublishingProviderRegistry,
} from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import type { PublishingChannelType, PublishingConnectionStatus } from "../../../api/generated/prisma";
import { PublishingCredentialCryptoService, PublishingCredentialDecryptionError } from "./publishing-credential-crypto.service";
import { PUBLISHING_PROVIDER_REGISTRY } from "./publishing-provider-registry.module";

export class PublishingChannelAccountNotFoundError extends Error {}
export class PublishingProviderNotConfiguredError extends Error {
  constructor(public readonly channelType: string) {
    super(`No publishing provider is configured for channel type "${channelType}".`);
  }
}

export interface ResolvedPublishingChannelContext {
  channelAccountId: string;
  channelAccountPublicId: string;
  channelType: PublishingChannelType;
  connectionStatus: PublishingConnectionStatus;
  tokenExpiresAt: Date | null;
  provider: PublishingChannelProvider;
}

/**
 * Module 9 Phase 9.3 — this worker process's own chokepoint through
 * which the execution service resolves a workspace-scoped
 * PublishingChannelAccount into its configured provider, mirroring
 * apps/api's identically-named service exactly (mechanical Prisma
 * fetch + the shared registry/crypto primitives — no business rule
 * re-implemented, only duplicated per the Phase 9.3 Execution Boundary
 * Checkpoint). Decrypted credential material is scoped to the body of
 * validateConnection()/withDecryptedCredential() alone — never assigned
 * to a field, returned, or logged.
 *
 * No NestJS HttpException here (this process has no HTTP layer) — plain
 * typed Error classes instead, which the execution service/processor
 * translates into a retryable/permanent BullMQ outcome.
 */
@Injectable()
export class PublishingProviderResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: PublishingCredentialCryptoService,
    @Inject(PUBLISHING_PROVIDER_REGISTRY) private readonly registry: PublishingProviderRegistry,
  ) {}

  async resolveChannelContext(workspaceId: string, channelAccountPublicId: string): Promise<ResolvedPublishingChannelContext> {
    const account = await this.prisma.publishingChannelAccount.findFirst({
      where: { workspaceId, publicId: channelAccountPublicId },
      select: { id: true, publicId: true, channelType: true, connectionStatus: true, credential: { select: { tokenExpiresAt: true } } },
    });
    if (!account) throw new PublishingChannelAccountNotFoundError("Channel account not found.");

    return {
      channelAccountId: account.id,
      channelAccountPublicId: account.publicId,
      channelType: account.channelType,
      connectionStatus: account.connectionStatus,
      tokenExpiresAt: account.credential?.tokenExpiresAt ?? null,
      provider: this.resolveProvider(account.channelType),
    };
  }

  async validateConnection(workspaceId: string, channelAccountPublicId: string): Promise<PublishingConnectionValidationResult> {
    const account = await this.prisma.publishingChannelAccount.findFirst({
      where: { workspaceId, publicId: channelAccountPublicId },
      select: { id: true, channelType: true, credential: { select: { ciphertext: true, nonce: true, authTag: true, keyVersion: true, tokenExpiresAt: true } } },
    });
    if (!account) throw new PublishingChannelAccountNotFoundError("Channel account not found.");
    if (!account.credential) {
      return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "No credential is stored for this channel account." };
    }

    const provider = this.resolveProvider(account.channelType);

    let decryptedCredential: Record<string, unknown>;
    try {
      decryptedCredential = this.crypto.decrypt(account.credential);
    } catch (err) {
      if (err instanceof PublishingCredentialDecryptionError) {
        return { healthy: false, reasonCode: "CREDENTIAL_INVALID", detail: "Stored credential could not be decrypted." };
      }
      throw err;
    }

    // Module 9 Phase 9.5 — a provider (e.g. YouTube) may need to
    // proactively/reactively refresh an OAuth access token even during a
    // read-only connection check. saveCheckpoint is a required part of
    // the shared callbacks shape but genuinely never called here (no
    // publish() is happening) — a no-op is correct, not a stub standing
    // in for missing behavior.
    const callbacks: PublishingExecutionCallbacks = {
      saveCheckpoint: async () => {},
      onCredentialRefreshed: (newCredential, tokenExpiresAt) => this.persistRefreshedCredential(workspaceId, channelAccountPublicId, newCredential, tokenExpiresAt),
    };

    return provider.validateConnection({ channelAccountId: account.id, decryptedCredential, tokenExpiresAt: account.credential.tokenExpiresAt }, callbacks);
  }

  /**
   * Module 9 Phase 9.5 — the ONE place a refreshed OAuth credential is
   * ever written back to `ChannelCredential`. A provider never calls
   * this itself (framework-free, no Prisma) — it only ever reaches here
   * via `PublishingExecutionCallbacks.onCredentialRefreshed`, which this
   * service and `PublishingExecutionService` are the sole suppliers of.
   * Re-encrypts through the SAME `PublishingCredentialCryptoService`
   * that decrypted it — no new/duplicated encryption logic. `credential`
   * replaces the full stored payload (the provider's own doc comment on
   * `onCredentialRefreshed` requires this); `tokenExpiresAt` updates the
   * plain, non-secret column alongside it when provided.
   *
   * A channel account that has since been disconnected/deleted (the
   * account or its credential row is gone) is not an error here — there
   * is nothing left to refresh, so this is a silent no-op rather than a
   * failure that would derail the actual publish/validate call this
   * refresh was only a side effect of.
   */
  async persistRefreshedCredential(workspaceId: string, channelAccountPublicId: string, credential: Record<string, unknown>, tokenExpiresAt?: Date | null): Promise<void> {
    const account = await this.prisma.publishingChannelAccount.findFirst({ where: { workspaceId, publicId: channelAccountPublicId }, select: { credentialId: true } });
    if (!account?.credentialId) return;
    const encrypted = this.crypto.encrypt(credential);
    await this.prisma.channelCredential.update({
      where: { id: account.credentialId },
      data: { ...encrypted, ...(tokenExpiresAt !== undefined ? { tokenExpiresAt } : {}) },
    });
  }

  /**
   * The execution service's own narrow credential-access boundary:
   * decrypts for exactly the duration of `fn`, never returns the
   * plaintext to its own caller. Throws PublishingCredentialDecryptionError
   * (uncaught, by design — a decryption failure at actual publish time is
   * a real execution failure the caller must classify, unlike
   * validateConnection()'s own soft `{healthy:false}` result).
   */
  async withDecryptedCredential<T>(workspaceId: string, channelAccountPublicId: string, fn: (decryptedCredential: Record<string, unknown>) => Promise<T>): Promise<T> {
    const account = await this.prisma.publishingChannelAccount.findFirst({
      where: { workspaceId, publicId: channelAccountPublicId },
      select: { credential: { select: { ciphertext: true, nonce: true, authTag: true, keyVersion: true } } },
    });
    if (!account?.credential) throw new PublishingChannelAccountNotFoundError("Channel account or its credential not found.");
    const decryptedCredential = this.crypto.decrypt(account.credential);
    return fn(decryptedCredential);
  }

  private resolveProvider(channelType: PublishingChannelType): PublishingChannelProvider {
    try {
      return this.registry.resolve(channelType);
    } catch (err) {
      if (err instanceof PublishingProviderRegistryValidationError) {
        throw new PublishingProviderNotConfiguredError(channelType);
      }
      throw err;
    }
  }
}
