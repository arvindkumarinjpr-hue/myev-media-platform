import { Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import {
  PublishingProviderRegistryValidationError,
  type PublishingChannelProvider,
  type PublishingConnectionValidationResult,
  type PublishingExecutionCallbacks,
  type PublishingProviderRegistry,
} from "@myev/shared";
import type { PublishingChannelType, PublishingConnectionStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { PublishingCredentialCryptoService, PublishingCredentialDecryptionError } from "./publishing-credential-crypto.service";
import { PUBLISHING_PROVIDER_REGISTRY } from "./publishing-provider-registry.factory";
import { PUBLISHING_ERRORS } from "./publishing.errors";

export interface ResolvedPublishingChannelContext {
  channelAccountId: string;
  channelAccountPublicId: string;
  channelType: PublishingChannelType;
  connectionStatus: PublishingConnectionStatus;
  tokenExpiresAt: Date | null;
  provider: PublishingChannelProvider;
}

/**
 * Module 9 Phase 9.2 — the one chokepoint through which any caller
 * (PublishingReadinessService now; publish execution in a later phase)
 * resolves a workspace-scoped PublishingChannelAccount into its
 * configured provider. Decrypted credential material is scoped to the
 * body of validateConnection() alone — it is never assigned to a field,
 * returned, or logged (Part G/N).
 *
 * Resolution failures follow the same idiom as every other workspace-
 * scoped lookup in this codebase (see internal-links-query.service.ts,
 * media-assets.service.ts): `findFirst({ where: { publicId, workspaceId
 * } })`, NotFoundException on miss — never a separate ownership-check
 * step, enumeration-safe by construction.
 */
@Injectable()
export class PublishingProviderResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: PublishingCredentialCryptoService,
    @Inject(PUBLISHING_PROVIDER_REGISTRY) private readonly registry: PublishingProviderRegistry,
  ) {}

  /** Resolves the channel account + its configured provider without touching credential material at all — safe to hold onto/pass around. */
  async resolveChannelContext(workspaceId: string, channelAccountPublicId: string): Promise<ResolvedPublishingChannelContext> {
    const account = await this.prisma.publishingChannelAccount.findFirst({
      where: { workspaceId, publicId: channelAccountPublicId },
      select: {
        id: true,
        publicId: true,
        channelType: true,
        connectionStatus: true,
        credential: { select: { tokenExpiresAt: true } },
      },
    });
    if (!account) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "Channel account not found." });
    }

    return {
      channelAccountId: account.id,
      channelAccountPublicId: account.publicId,
      channelType: account.channelType,
      connectionStatus: account.connectionStatus,
      tokenExpiresAt: account.credential?.tokenExpiresAt ?? null,
      provider: this.resolveProvider(account.channelType),
    };
  }

  /**
   * Decrypts credential material for exactly the lifetime of this one
   * call, passes it directly into the provider's own validateConnection
   * (never assigned to a field, never returned, never logged), and maps
   * the result to a typed outcome. No real network call happens in
   * Phase 9.2 — only the fixture provider is registered, and it is
   * fully deterministic/in-memory.
   */
  async validateConnection(workspaceId: string, channelAccountPublicId: string): Promise<PublishingConnectionValidationResult> {
    const account = await this.prisma.publishingChannelAccount.findFirst({
      where: { workspaceId, publicId: channelAccountPublicId },
      select: {
        id: true,
        channelType: true,
        credential: { select: { ciphertext: true, nonce: true, authTag: true, keyVersion: true, tokenExpiresAt: true } },
      },
    });
    if (!account) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "Channel account not found." });
    }
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

    // decryptedCredential's scope ends with this call — never captured
    // by anything outside provider.validateConnection()'s own body.
    return provider.validateConnection(
      {
        channelAccountId: account.id,
        decryptedCredential,
        tokenExpiresAt: account.credential.tokenExpiresAt,
      },
      callbacks,
    );
  }

  /**
   * Module 9 Phase 9.5 — the ONE place a refreshed OAuth credential is
   * ever written back to `ChannelCredential` from apps/api. Mirrors
   * apps/worker's own identically-named method exactly — see its doc
   * comment. Re-encrypts through the SAME `PublishingCredentialCryptoService`
   * that decrypted it; never duplicates encryption logic.
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

  private resolveProvider(channelType: PublishingChannelType): PublishingChannelProvider {
    try {
      return this.registry.resolve(channelType);
    } catch (err) {
      if (err instanceof PublishingProviderRegistryValidationError) {
        throw new UnprocessableEntityException({
          code: PUBLISHING_ERRORS.PUBLISHING_PROVIDER_NOT_CONFIGURED,
          message: `No publishing provider is configured for channel type "${channelType}".`,
        });
      }
      throw err;
    }
  }
}
