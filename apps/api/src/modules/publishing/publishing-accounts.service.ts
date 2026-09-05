import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { PublishingChannelProvider, PublishingProviderRegistry } from "@myev/shared";
import { Prisma, type PublishingChannelAccount, type PublishingChannelType } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PublishingAccountHealthService } from "./publishing-account-health.service";
import { PublishingCredentialCryptoService } from "./publishing-credential-crypto.service";
import { PUBLISHING_PROVIDER_REGISTRY } from "./publishing-provider-registry.factory";
import { PUBLISHING_ERRORS } from "./publishing.errors";

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

interface RequestContext {
  ipAddress?: string;
}

export interface PublishingAccountView {
  publicId: string;
  channelType: PublishingChannelType;
  displayName: string;
  externalAccountId: string;
  connectionStatus: string;
  tokenExpiresAt: Date | null;
  lastVerifiedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Module 9 Phase 9.7 (Part E/F/L/M) — workspace-safe account-management
 * operations for all four channels. NEVER selects/returns
 * `ciphertext`/`nonce`/`authTag`/`keyVersion` in any read path (Part E:
 * "Never return credential plaintext... No ciphertext/nonce/authTag
 * exposure") — `toView()` is the one, single projection every read call
 * site uses, so a future field addition to ChannelCredential can never
 * leak through a forgotten second projection.
 */
@Injectable()
export class PublishingAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly crypto: PublishingCredentialCryptoService,
    private readonly health: PublishingAccountHealthService,
    @Inject(PUBLISHING_PROVIDER_REGISTRY) private readonly registry: PublishingProviderRegistry,
  ) {}

  async list(workspaceId: string): Promise<PublishingAccountView[]> {
    const accounts = await this.prisma.publishingChannelAccount.findMany({ where: { workspaceId }, include: { credential: { select: { tokenExpiresAt: true } } }, orderBy: { connectedAt: "desc" } });
    return accounts.map((a) => this.toView(a, a.credential?.tokenExpiresAt ?? null));
  }

  async detail(workspaceId: string, accountPublicId: string): Promise<PublishingAccountView> {
    const account = await this.findAccountOrThrow(workspaceId, accountPublicId);
    const credential = await this.prisma.channelCredential.findFirst({ where: { id: account.credentialId, workspaceId }, select: { tokenExpiresAt: true } });
    return this.toView(account, credential?.tokenExpiresAt ?? null);
  }

  /**
   * Part F: validate -> encrypt -> persist ONLY after successful
   * validation — an invalid site URL/credential never creates a row at
   * all (no "connected but broken" account is ever possible for
   * WordPress).
   */
  async connectWordPress(
    workspaceId: string,
    actorUserId: string,
    input: { siteUrl: string; username: string; applicationPassword: string; displayName: string },
    context: RequestContext = {},
  ): Promise<PublishingAccountView> {
    const provider = this.resolveProvider("WORDPRESS");
    const credentialPayload = { siteUrl: input.siteUrl, username: input.username, applicationPassword: input.applicationPassword };

    const validation = await provider.validateConnection({ channelAccountId: "pending-connect", decryptedCredential: credentialPayload, tokenExpiresAt: null });
    if (!validation.healthy) {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_WORDPRESS_VALIDATION_FAILED, message: validation.detail ?? "WordPress connection validation failed." });
    }

    const encrypted = this.crypto.encrypt(credentialPayload);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const credential = await tx.channelCredential.create({ data: { workspaceId, ...encrypted, tokenExpiresAt: null } });
        const account = await tx.publishingChannelAccount.create({
          data: {
            workspaceId,
            channelType: "WORDPRESS",
            displayName: input.displayName,
            externalAccountId: input.siteUrl,
            connectionStatus: "CONNECTED",
            credentialId: credential.id,
            connectedById: actorUserId,
            lastVerifiedAt: new Date(),
          },
        });
        await this.audit.recordWithinTransaction(tx, {
          action: "PUBLISHING_CHANNEL_ACCOUNT_CONNECTED",
          actorUserId,
          workspaceId,
          entityType: "publishing_channel_account",
          entityId: account.publicId,
          afterState: { channelType: "WORDPRESS", externalAccountId: input.siteUrl },
          ipAddress: context.ipAddress,
        });
        return this.toView(account, null);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({ code: PUBLISHING_ERRORS.PUBLISHING_ACCOUNT_ALREADY_CONNECTED, message: "This WordPress site is already connected in this workspace." });
      }
      throw error;
    }
  }

  /** Credential rotation (Part F/AA) — replaces the stored secret for an EXISTING WordPress account after re-validating it; never a plaintext read/echo. */
  async rotateWordPressCredential(
    workspaceId: string,
    actorUserId: string,
    accountPublicId: string,
    input: { siteUrl: string; username: string; applicationPassword: string },
    context: RequestContext = {},
  ): Promise<PublishingAccountView> {
    const account = await this.findAccountOrThrow(workspaceId, accountPublicId);
    if (account.channelType !== "WORDPRESS") {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_WORDPRESS_VALIDATION_FAILED, message: "Credential rotation via this endpoint is only supported for WordPress accounts." });
    }
    const provider = this.resolveProvider("WORDPRESS");
    const credentialPayload = { siteUrl: input.siteUrl, username: input.username, applicationPassword: input.applicationPassword };
    const validation = await provider.validateConnection({ channelAccountId: account.publicId, decryptedCredential: credentialPayload, tokenExpiresAt: null });
    if (!validation.healthy) {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_WORDPRESS_VALIDATION_FAILED, message: validation.detail ?? "WordPress connection validation failed." });
    }

    const encrypted = this.crypto.encrypt(credentialPayload);
    await this.prisma.$transaction(async (tx) => {
      await tx.channelCredential.update({ where: { id: account.credentialId }, data: { ...encrypted, tokenExpiresAt: null } });
      await tx.publishingChannelAccount.update({ where: { id: account.id }, data: { externalAccountId: input.siteUrl } });
      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLISHING_CREDENTIAL_ROTATED",
        actorUserId,
        workspaceId,
        entityType: "publishing_channel_account",
        entityId: account.publicId,
        ipAddress: context.ipAddress,
      });
    });
    const updated = await this.health.markConnected(workspaceId, accountPublicId, { actorUserId, ipAddress: context.ipAddress });
    return this.toView(updated, null);
  }

  /** "Test connection" (Part L) — calls the provider's own validateConnection() against the CURRENTLY stored credential and updates health through the one shared boundary. Never exposes the raw provider response. */
  async testConnection(workspaceId: string, accountPublicId: string, context: RequestContext = {}): Promise<PublishingAccountView> {
    const account = await this.findAccountOrThrow(workspaceId, accountPublicId);
    const credentialRow = await this.prisma.channelCredential.findFirst({ where: { id: account.credentialId, workspaceId } });
    if (!credentialRow) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CREDENTIAL_UNAVAILABLE, message: "No credential is stored for this channel account." });
    }
    const provider = this.resolveProvider(account.channelType);
    const decrypted = this.crypto.decrypt(credentialRow);
    const validation = await provider.validateConnection({ channelAccountId: account.publicId, decryptedCredential: decrypted, tokenExpiresAt: credentialRow.tokenExpiresAt });
    const updated = await this.health.applyValidationResult(workspaceId, accountPublicId, validation, context);
    const refreshedCredential = await this.prisma.channelCredential.findFirst({ where: { id: updated.credentialId }, select: { tokenExpiresAt: true } });
    return this.toView(updated, refreshedCredential?.tokenExpiresAt ?? null);
  }

  /** Disconnect (Part M): marks REVOKED via the shared health boundary — never deletes the account, its credential row, or any Publication/PublicationTarget/PublishAttempt history. A REVOKED account still resolves for read (history stays visible) but readiness will report CHANNEL_ACCOUNT_NOT_CONNECTED for any new publish attempt. */
  async disconnect(workspaceId: string, accountPublicId: string, context: RequestContext = {}): Promise<PublishingAccountView> {
    await this.findAccountOrThrow(workspaceId, accountPublicId);
    const updated = await this.health.markRevoked(workspaceId, accountPublicId, context);
    return this.toView(updated, null);
  }

  private async findAccountOrThrow(workspaceId: string, accountPublicId: string): Promise<PublishingChannelAccount> {
    const account = await this.prisma.publishingChannelAccount.findFirst({ where: { workspaceId, publicId: accountPublicId } });
    if (!account) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "Channel account not found." });
    }
    return account;
  }

  private resolveProvider(channelType: PublishingChannelType): PublishingChannelProvider {
    try {
      return this.registry.resolve(channelType);
    } catch {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_PROVIDER_NOT_CONFIGURED, message: `No publishing provider is configured for channel type "${channelType}".` });
    }
  }

  private toView(account: PublishingChannelAccount, tokenExpiresAt: Date | null): PublishingAccountView {
    return {
      publicId: account.publicId,
      channelType: account.channelType,
      displayName: account.displayName,
      externalAccountId: account.externalAccountId,
      connectionStatus: account.connectionStatus,
      tokenExpiresAt,
      lastVerifiedAt: account.lastVerifiedAt,
      disconnectedAt: account.disconnectedAt,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  /** Exposed for the OAuth callback service (Part G/H) — the one place a NEW OAuth-backed account is created, mirroring connectWordPress's own create-then-audit shape but with a caller-supplied already-encrypted credential (the callback service owns the provider-specific identity/credential resolution; this method owns only the generic "create the account + credential rows + audit" mechanics). */
  async createFromOAuth(
    workspaceId: string,
    actorUserId: string,
    input: { channelType: PublishingChannelType; displayName: string; externalAccountId: string; decryptedCredential: Record<string, unknown>; tokenExpiresAt: Date | null; capabilitiesSnapshot?: Record<string, unknown> },
    context: RequestContext = {},
  ): Promise<PublishingAccountView> {
    const encrypted = this.crypto.encrypt(input.decryptedCredential);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const credential = await tx.channelCredential.create({ data: { workspaceId, ...encrypted, tokenExpiresAt: input.tokenExpiresAt } });
        const account = await tx.publishingChannelAccount.create({
          data: {
            workspaceId,
            channelType: input.channelType,
            displayName: input.displayName,
            externalAccountId: input.externalAccountId,
            connectionStatus: "CONNECTED",
            credentialId: credential.id,
            connectedById: actorUserId,
            lastVerifiedAt: new Date(),
            capabilitiesSnapshot: input.capabilitiesSnapshot as Prisma.InputJsonValue | undefined,
          },
        });
        await this.audit.recordWithinTransaction(tx, {
          action: "PUBLISHING_CHANNEL_ACCOUNT_CONNECTED",
          actorUserId,
          workspaceId,
          entityType: "publishing_channel_account",
          entityId: account.publicId,
          afterState: { channelType: input.channelType, externalAccountId: input.externalAccountId },
          ipAddress: context.ipAddress,
        });
        return this.toView(account, input.tokenExpiresAt);
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({ code: PUBLISHING_ERRORS.PUBLISHING_ACCOUNT_ALREADY_CONNECTED, message: "This account is already connected in this workspace." });
      }
      throw error;
    }
  }

  /**
   * Reconnect-via-OAuth for an EXISTING, previously-revoked/expired
   * account (Part AA "Reconnect/Update") — rotates the credential in
   * place rather than creating a duplicate `PublishingChannelAccount`
   * row for the same external identity (the unique constraint on
   * (workspaceId, channelType, externalAccountId) would reject a second
   * create anyway; this is the intentional, audited path for the same
   * outcome).
   */
  async reconnectFromOAuth(
    workspaceId: string,
    actorUserId: string,
    accountPublicId: string,
    input: { decryptedCredential: Record<string, unknown>; tokenExpiresAt: Date | null },
    context: RequestContext = {},
  ): Promise<PublishingAccountView> {
    const account = await this.findAccountOrThrow(workspaceId, accountPublicId);
    const encrypted = this.crypto.encrypt(input.decryptedCredential);
    await this.prisma.$transaction(async (tx) => {
      await tx.channelCredential.update({ where: { id: account.credentialId }, data: { ...encrypted, tokenExpiresAt: input.tokenExpiresAt } });
      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLISHING_CREDENTIAL_ROTATED",
        actorUserId,
        workspaceId,
        entityType: "publishing_channel_account",
        entityId: account.publicId,
        ipAddress: context.ipAddress,
      });
    });
    const updated = await this.health.markConnected(workspaceId, accountPublicId, { actorUserId, ipAddress: context.ipAddress });
    return this.toView(updated, input.tokenExpiresAt);
  }

  /** Internal helper the OAuth callback service uses to find an existing account by its external identity before deciding create-vs-reconnect. */
  async findByExternalIdentity(workspaceId: string, channelType: PublishingChannelType, externalAccountId: string): Promise<PublishingChannelAccount | null> {
    return this.prisma.publishingChannelAccount.findFirst({ where: { workspaceId, channelType, externalAccountId } });
  }
}
