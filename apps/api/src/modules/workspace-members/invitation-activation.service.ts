import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma } from "../../../generated/prisma";
import { TokenService } from "../../common/crypto/token.service";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email-provider.interface";
import type { AppConfig } from "../../config/configuration";

interface IssueActivationTokenOptions {
  initiatingWorkspacePublicId?: string;
  workspaceNameForEmail?: string;
  reason: string;
}

interface IssuedToken {
  plaintext: string;
  email: string;
  fullName: string;
}

/**
 * Module 1C Engineering Plan §3 (activation resend cross-workspace
 * behavior). ACCOUNT_ACTIVATION tokens are strictly user-level — this is
 * the one place that ever invalidates-and-reissues one, called both from
 * the initial new-user invitation-accept path and from the explicit
 * resend-activation endpoint, so the two can never drift into different
 * behavior.
 */
@Injectable()
export class InvitationActivationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly audit: AuditService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /**
   * The DB-write half, usable inside a caller-supplied transaction — used
   * directly by InvitationsService.accept() so a brand-new user's account,
   * membership, AND activation token are all created atomically in one
   * transaction. Splitting token issuance into its own separate
   * transaction (the original shape here) meant a failure issuing the
   * token — as happened live, from the uuid/text cast bug below — left a
   * PENDING_ACTIVATION user permanently stuck with no valid token to ever
   * activate with. Merging them closes that gap the same way Module 1B.1
   * learned to, twice.
   */
  async issueActivationTokenWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    options: IssueActivationTokenOptions,
  ): Promise<IssuedToken> {
    const ttlSeconds = this.config.get("auth", { infer: true }).activationTokenTtlSeconds;
    const plaintext = this.tokenService.generateOpaqueToken();
    const tokenHash = this.tokenService.hashToken(plaintext);

    // Row lock serializes concurrent resend/issue attempts for the same
    // user — mandatory safeguard 3: "concurrent resend requests are
    // serialized." Every column explicitly aliased to its camelCase Prisma
    // field name (the fix for the 1B.1 raw-query bug), and the id
    // parameter explicitly cast ::uuid — Postgres has no implicit
    // uuid <-> text comparison, and an unmarked parameter fails at runtime
    // with "operator does not exist: uuid = text" (caught live, against
    // the real database, not by typecheck or a mocked test).
    const [lockedUser] = await tx.$queryRaw<Array<{ id: string; publicId: string; email: string; fullName: string }>>`
      SELECT id, public_id AS "publicId", email, full_name AS "fullName" FROM users WHERE id = ${userId}::uuid FOR UPDATE
    `;

    const priorPending = await tx.userActionToken.findMany({
      where: { userId, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
    });
    await tx.userActionToken.updateMany({
      where: { userId, purpose: "ACCOUNT_ACTIVATION", status: "PENDING" },
      data: { status: "INVALIDATED" },
    });
    await tx.userActionToken.create({
      data: { userId, purpose: "ACCOUNT_ACTIVATION", tokenHash, expiresAt: new Date(Date.now() + ttlSeconds * 1000) },
    });

    // Mandatory safeguard 1: metadata only. No token hash, fingerprint,
    // plaintext, or password-derived value ever appears here — the
    // authoritative hash lives only in user_action_tokens.
    await this.audit.recordWithinTransaction(tx, {
      action: "ACCOUNT_ACTIVATION_TOKEN_ROTATED",
      actorUserId: userId,
      workspaceId: null, // global — this is a user-level action, not tied to one workspace
      entityType: "user",
      entityId: lockedUser.publicId,
      afterState: {
        invalidatedTokenCount: priorPending.length,
        newTokenIssued: true,
        reason: options.reason,
        initiatingWorkspacePublicId: options.initiatingWorkspacePublicId ?? null,
      },
    });

    return { plaintext, email: lockedUser.email, fullName: lockedUser.fullName };
  }

  /** Standalone issuance (the resend-activation endpoint) — its own transaction, then the email. */
  async issueActivationToken(userId: string, options: IssueActivationTokenOptions): Promise<void> {
    const issued = await this.prisma.$transaction((tx) => this.issueActivationTokenWithinTransaction(tx, userId, options));
    await this.sendActivationEmail(issued, options.workspaceNameForEmail);
  }

  async sendActivationEmail(issued: IssuedToken, workspaceName: string | undefined): Promise<void> {
    const ttlSeconds = this.config.get("auth", { infer: true }).activationTokenTtlSeconds;
    const activationUrl = `${this.config.get("appUrl", { infer: true })}/activate?token=${issued.plaintext}`;
    await this.emailProvider.send(issued.email, "ACCOUNT_ACTIVATION", {
      recipientName: issued.fullName,
      activationUrl,
      expiresInMinutes: Math.round(ttlSeconds / 60),
      // Deliberately only ever the ONE initiating workspace's name — never
      // a list, never a count, of any other workspace the recipient may
      // also be pending in (Module 1C Engineering Plan §3).
      workspaceName,
    });
  }
}
