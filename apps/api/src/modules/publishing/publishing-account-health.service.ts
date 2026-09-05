import { Injectable, NotFoundException } from "@nestjs/common";
import type { PublishingConnectionValidationResult } from "@myev/shared";
import type { PublishingChannelAccount, PublishingConnectionStatus } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { PUBLISHING_ERRORS } from "./publishing.errors";

interface RequestContext {
  actorUserId?: string;
  ipAddress?: string;
}

/**
 * Module 9 Phase 9.7 (Part K) — the ONE shared boundary every one of the
 * four connectors' account-health writes goes through. No provider-
 * specific service (WordPress connect, YouTube/Meta OAuth callback,
 * "Test connection") ever calls `prisma.publishingChannelAccount.update()`
 * on `connectionStatus` directly — every write is this class's own,
 * so the truthful-transition rules below are enforced in exactly one
 * place, never re-implemented per connector (avoiding the "Meta-only
 * lifecycle updater" pitfall Phase 9.4/9.5's own Part R/AF explicitly
 * warned against).
 *
 * `PublishingConnectionStatus` (CONNECTED/EXPIRED/REVOKED/ERROR) is the
 * EXISTING, Phase 9.1-frozen enum — confirmed sufficient for Phase 9.7's
 * needs (Part AH), no migration.
 */
@Injectable()
export class PublishingAccountHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Maps a provider's own `validateConnection()` outcome onto a truthful
   * status transition — the ONLY call site that needs to know how a
   * `PublishingConnectionValidationReasonCode` maps to an account-level
   * health state:
   *  - healthy -> CONNECTED (+ lastVerifiedAt bump)
   *  - CREDENTIAL_EXPIRED -> EXPIRED
   *  - CREDENTIAL_REVOKED -> REVOKED
   *  - CREDENTIAL_INVALID -> ERROR (a genuine, non-recoverable-by-waiting credential problem — distinct from REVOKED, since not every provider can tell "invalid" and "revoked" apart, but neither is a transient failure)
   *  - PROVIDER_UNAVAILABLE -> NO CHANGE. A transient 429/5xx/network
   *    blip must never downgrade an account's persisted health (Part K:
   *    "transient failures must not revoke an account") — the caller
   *    still sees the failure via the returned safe result, it just
   *    doesn't get written as a persistent fact about the account.
   */
  async applyValidationResult(workspaceId: string, accountPublicId: string, result: PublishingConnectionValidationResult, context: RequestContext = {}): Promise<PublishingChannelAccount> {
    const account = await this.prisma.publishingChannelAccount.findFirst({ where: { workspaceId, publicId: accountPublicId } });
    if (!account) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "Channel account not found." });
    }

    if (result.healthy) {
      return this.transition(account, "CONNECTED", context, { verified: true });
    }
    const nextStatus = this.mapReasonCodeToStatus(result.reasonCode);
    if (!nextStatus) {
      // PROVIDER_UNAVAILABLE, or an unmapped/unknown reason — leave the
      // persisted status exactly as it was.
      return account;
    }
    return this.transition(account, nextStatus, context, { reasonCode: result.reasonCode });
  }

  /** Direct, explicit REVOKED write for the disconnect action (Part M) — not derived from a validation result, since a disconnect is a deliberate operator decision, not a provider-reported fact. */
  async markRevoked(workspaceId: string, accountPublicId: string, context: RequestContext = {}): Promise<PublishingChannelAccount> {
    const account = await this.prisma.publishingChannelAccount.findFirst({ where: { workspaceId, publicId: accountPublicId } });
    if (!account) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "Channel account not found." });
    }
    return this.transition(account, "REVOKED", context, { reason: "disconnected_by_operator" }, { disconnectedAt: new Date() });
  }

  /** Direct CONNECTED write for a freshly created/reconnected account (WordPress connect success; OAuth callback success) — same shared boundary, called once at account-creation time rather than duplicating the write. */
  async markConnected(workspaceId: string, accountPublicId: string, context: RequestContext = {}): Promise<PublishingChannelAccount> {
    const account = await this.prisma.publishingChannelAccount.findFirst({ where: { workspaceId, publicId: accountPublicId } });
    if (!account) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND, message: "Channel account not found." });
    }
    return this.transition(account, "CONNECTED", context, { verified: true });
  }

  private mapReasonCodeToStatus(reasonCode: PublishingConnectionValidationResult["reasonCode"]): PublishingConnectionStatus | null {
    switch (reasonCode) {
      case "CREDENTIAL_EXPIRED":
        return "EXPIRED";
      case "CREDENTIAL_REVOKED":
        return "REVOKED";
      case "CREDENTIAL_INVALID":
        return "ERROR";
      case "PROVIDER_UNAVAILABLE":
      default:
        return null;
    }
  }

  private async transition(
    account: PublishingChannelAccount,
    toStatus: PublishingConnectionStatus,
    context: RequestContext,
    afterDetail: Record<string, unknown>,
    extraData: Record<string, unknown> = {},
  ): Promise<PublishingChannelAccount> {
    if (account.connectionStatus === toStatus) {
      // Idempotent — a repeated identical health result (e.g. two
      // successive successful validations) is not a real transition and
      // must not spam the audit log.
      if (toStatus === "CONNECTED") {
        return this.prisma.publishingChannelAccount.update({ where: { id: account.id }, data: { lastVerifiedAt: new Date() } });
      }
      return account;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.publishingChannelAccount.update({
        where: { id: account.id },
        data: {
          connectionStatus: toStatus,
          ...(toStatus === "CONNECTED" ? { lastVerifiedAt: new Date() } : {}),
          ...extraData,
        },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "PUBLISHING_CHANNEL_ACCOUNT_STATUS_CHANGED",
        actorUserId: context.actorUserId,
        workspaceId: account.workspaceId,
        entityType: "publishing_channel_account",
        entityId: account.publicId,
        beforeState: { connectionStatus: account.connectionStatus },
        afterState: { connectionStatus: toStatus, ...afterDetail },
        ipAddress: context.ipAddress,
      });
      return result;
    });
    return updated;
  }
}
