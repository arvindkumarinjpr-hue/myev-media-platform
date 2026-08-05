import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type WorkspaceInvitation } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { TokenService } from "../../common/crypto/token.service";
import { AuditService } from "../audit/audit.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email-provider.interface";
import type { AppConfig } from "../../config/configuration";
import { InvitationActivationService } from "./invitation-activation.service";
import type { InviteMemberDto } from "./dto/invite-member.dto";

interface RequestContext {
  ipAddress?: string;
}

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

/**
 * Module 1C.1 final concurrency correction: the row lock on
 * workspace_invitations (see accept()) is the primary defense against a
 * same-token race and makes these two P2002 catches unreachable for that
 * case. They stay only for a race the lock does NOT cover — two *different*
 * invitation tokens (different rows, so no contention on the same FOR
 * UPDATE lock) that resolve to the same target identity concurrently: two
 * pending invitations to the same not-yet-existing email (accept() Case B's
 * tx.user.create()), or two pending invitations to the same email for the
 * same workspace (tx.workspaceMember.create()). Narrowed to the exact
 * expected constraint via error.meta.target so an unrelated P2002 at the
 * same call site is never misreported as this.
 */
function isExpectedUniqueViolation(error: unknown, columnSubstrings: string[]): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== UNIQUE_CONSTRAINT_VIOLATION) {
    return false;
  }
  const target = error.meta?.target;
  const targets = Array.isArray(target) ? target : typeof target === "string" ? [target] : [];
  return columnSubstrings.every((needle) =>
    targets.some((entry) => typeof entry === "string" && entry.toLowerCase().includes(needle.toLowerCase())),
  );
}

interface LockedInvitationRow {
  id: string;
  publicId: string;
  workspaceId: string;
  invitedEmail: string;
  invitedUserId: string | null;
  roleId: string;
  tokenHash: string;
  status: WorkspaceInvitation["status"];
  invitedById: string;
  acceptedById: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly audit: AuditService,
    private readonly activation: InvitationActivationService,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async invite(
    workspaceId: string,
    workspaceName: string,
    inviterUserId: string,
    dto: InviteMemberDto,
    context: RequestContext,
  ): Promise<void> {
    const email = dto.email.toLowerCase();
    const [role, inviter] = await Promise.all([
      this.prisma.role.findUniqueOrThrow({ where: { name: dto.roleName } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: inviterUserId } }),
    ]);

    const existingUser = await this.prisma.user.findFirst({ where: { email, deletedAt: null } });
    if (existingUser) {
      const existingMembership = await this.prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: existingUser.id } },
      });
      if (existingMembership?.status === "ACTIVE") {
        throw new ConflictException({ code: "ALREADY_MEMBER", message: "This user is already a member of this workspace." });
      }
    }

    // Module 1C Engineering Plan §2.C″(A): bind the invitation to a
    // specific account only when an ACTIVE user exists right now — immune
    // to any later email change on that account. A PENDING_ACTIVATION user
    // (e.g. mid-onboarding via a *different* workspace's invitation) has no
    // completed identity yet and no session to ever prove EMAIL_MISMATCH
    // against, so binding invitedUserId here would make this invitation
    // permanently unacceptable (accept() would demand a session that can
    // never exist). Found live: inviting the same still-pending email to a
    // second workspace produced a 401 on accept(), then (once that was
    // worked around) an unhandled unique-constraint crash from accept()'s
    // case-B branch blindly re-creating a user that already existed.
    // Treated as Case B — see accept()'s reuse-existing-pending-user logic.
    const boundUserId = existingUser?.status === "ACTIVE" ? existingUser.id : null;

    const ttlSeconds = this.config.get("workspace", { infer: true }).invitationTtlSeconds;
    const plaintext = this.tokenService.generateOpaqueToken();
    const tokenHash = this.tokenService.hashToken(plaintext);

    try {
      await this.prisma.$transaction(async (tx) => {
        // Application-level supersede — the partial unique index on
        // (workspace_id, invited_email) WHERE status='PENDING' is the DB
        // backstop if a concurrent request races this.
        await tx.workspaceInvitation.updateMany({
          where: { workspaceId, invitedEmail: email, status: "PENDING" },
          data: { status: "EXPIRED" },
        });
        await tx.workspaceInvitation.create({
          data: {
            workspaceId,
            invitedEmail: email,
            invitedUserId: boundUserId,
            roleId: role.id,
            tokenHash,
            expiresAt: new Date(Date.now() + ttlSeconds * 1000),
            invitedById: inviterUserId,
          },
        });
        await this.audit.recordWithinTransaction(tx, {
          action: "WORKSPACE_INVITATION_CREATED",
          actorUserId: inviterUserId,
          workspaceId,
          entityType: "workspace_invitation",
          entityId: email,
          ipAddress: context.ipAddress,
        });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
        throw new ConflictException({ code: "INVITATION_ALREADY_PENDING", message: "An invitation is already pending for this email." });
      }
      throw error;
    }

    const acceptUrl = `${this.config.get("appUrl", { infer: true })}/invitations/accept?token=${plaintext}`;
    await this.emailProvider.send(email, "WORKSPACE_INVITATION", {
      recipientName: existingUser?.fullName ?? "there",
      workspaceName,
      inviterName: inviter.fullName,
      acceptUrl,
      expiresInDays: Math.max(1, Math.round(ttlSeconds / 86_400)),
    });
  }

  async list(workspaceId: string): Promise<WorkspaceInvitation[]> {
    return this.prisma.workspaceInvitation.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" } });
  }

  async revoke(workspaceId: string, invitationPublicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const invitation = await this.prisma.workspaceInvitation.findFirst({ where: { publicId: invitationPublicId, workspaceId } });
    if (!invitation) {
      throw new BadRequestException({ code: "INVITATION_NOT_FOUND", message: "Invitation not found." });
    }
    if (invitation.status !== "PENDING") {
      throw new ConflictException({ code: "INVITATION_NOT_PENDING", message: "Only a pending invitation can be revoked." });
    }
    await this.prisma.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });
    await this.audit.record({
      action: "WORKSPACE_INVITATION_REVOKED",
      actorUserId,
      workspaceId,
      entityType: "workspace_invitation",
      entityId: invitation.publicId,
      ipAddress: context.ipAddress,
    });
  }

  /** Public, token-authenticated preview — no session required. */
  async previewByToken(tokenPlaintext: string): Promise<{ workspaceName: string; roleName: string; invitedEmail: string; expiresAt: Date }> {
    const tokenHash = this.tokenService.hashToken(tokenPlaintext);
    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash },
      include: { workspace: true, role: true },
    });
    if (!invitation || invitation.status !== "PENDING") {
      throw new BadRequestException({ code: "INVITATION_INVALID", message: "This invitation link is invalid." });
    }
    if (invitation.expiresAt < new Date()) {
      throw new GoneException({ code: "INVITATION_EXPIRED", message: "This invitation has expired." });
    }
    return {
      workspaceName: invitation.workspace.name,
      roleName: invitation.role.name,
      invitedEmail: invitation.invitedEmail,
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Module 1C Engineering Plan §2.C″. `sessionUserPublicId` is null when
   * the caller has no session at all (the only valid case for that: a
   * brand-new invitee with no account yet).
   */
  async accept(
    tokenPlaintext: string,
    sessionUserPublicId: string | null,
    context: RequestContext,
  ): Promise<{ requiresActivation: boolean }> {
    const tokenHash = this.tokenService.hashToken(tokenPlaintext);

    const result = await this.prisma.$transaction(async (tx) => {
      // Step 1: lock the invitation row FIRST, before any branching into
      // user/membership logic. token_hash is TEXT (not uuid), so unlike
      // the id columns locked elsewhere in this codebase (transferOwnership,
      // issueActivationTokenWithinTransaction) no ::uuid cast is needed here
      // — the bound parameter and the column are already the same type.
      // Every column is explicitly aliased to its Prisma camelCase name,
      // never SELECT *, matching the established pattern.
      const [invitation] = await tx.$queryRaw<LockedInvitationRow[]>`
        SELECT
          id,
          public_id AS "publicId",
          workspace_id AS "workspaceId",
          invited_email AS "invitedEmail",
          invited_user_id AS "invitedUserId",
          role_id AS "roleId",
          token_hash AS "tokenHash",
          status,
          invited_by AS "invitedById",
          accepted_by AS "acceptedById",
          expires_at AS "expiresAt",
          accepted_at AS "acceptedAt",
          revoked_at AS "revokedAt",
          created_at AS "createdAt"
        FROM workspace_invitations
        WHERE token_hash = ${tokenHash}
        FOR UPDATE
      `;

      // Step 2: revalidate the locked state. A second concurrent request
      // blocks on the FOR UPDATE above until the first transaction commits,
      // then re-reads here and sees whatever the first one left behind —
      // this re-check, not a downstream unique constraint, is what rejects
      // the loser. No state-changing write happens before this point.
      if (!invitation) {
        throw new NotFoundException({ code: "INVITATION_INVALID", message: "This invitation link is invalid." });
      }
      if (invitation.status === "ACCEPTED") {
        throw new ConflictException({
          code: "INVITATION_ALREADY_ACCEPTED",
          message: "This invitation has already been accepted.",
          source: "invitation_lock",
        });
      }
      if (invitation.status === "REVOKED") {
        throw new GoneException({ code: "INVITATION_INVALID", message: "This invitation has already been used or revoked." });
      }
      if (invitation.status === "EXPIRED" || invitation.expiresAt < new Date()) {
        if (invitation.status !== "EXPIRED") {
          await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
        }
        throw new GoneException({ code: "INVITATION_EXPIRED", message: "This invitation has expired." });
      }
      // invitation.status === "PENDING" — continue.

      const workspace = await tx.workspace.findUniqueOrThrow({ where: { id: invitation.workspaceId } });

      if (invitation.invitedUserId) {
        // Case A: bound to a specific account at creation time — immune to
        // later email changes on that account.
        const sessionUser = await this.requireMatchingSession(tx, sessionUserPublicId, invitation.invitedUserId);
        await this.joinAsActive(tx, invitation, sessionUser.id, context);
        return { requiresActivation: false as const };
      }

      // Case B: no ACTIVE user existed at creation time. Re-resolve fresh —
      // never trust the creation-time NULL (Module 1C Engineering Plan
      // §2.C″: "what happens if an account with that email appears...").
      const currentUserForEmail = await tx.user.findFirst({ where: { email: invitation.invitedEmail, deletedAt: null } });

      if (currentUserForEmail?.status === "ACTIVE") {
        // Residual-risk fallback, explicitly documented in the plan: token
        // possession + a session matching the current email — the same
        // identity strength this platform already accepted pre-correction.
        const sessionUser = await this.requireMatchingSessionByEmail(tx, sessionUserPublicId, invitation.invitedEmail);
        await this.joinAsActive(tx, invitation, sessionUser.id, context);
        return { requiresActivation: false as const };
      }

      // Step 4: create/reuse user. A user for this email may already exist
      // as PENDING_ACTIVATION — invited to a *different* workspace first,
      // still mid-onboarding. Reuse that same account rather than
      // attempting a second tx.user.create() with the same email: the
      // whole point of user-level activation tokens (Module 1C Engineering
      // Plan §3) is that one eventual activation must cover every
      // workspace this person was invited to, not just whichever came
      // first.
      //
      // The invitation-row lock above closes the same-token race entirely
      // (a second request for THIS token now blocks, then sees ACCEPTED at
      // step 2, and never reaches here). This catch stays reachable for a
      // *different* race the per-invitation lock cannot cover: two
      // different, concurrently-accepted invitation tokens (different
      // rows, no shared lock) that both target this same not-yet-existing
      // email — e.g. two separate pending invitations to one person.
      // Narrowed to the users.email constraint specifically via
      // error.meta.target, so an unrelated P2002 at this call site (were
      // one ever possible) is rethrown untouched rather than misreported.
      const targetUser =
        currentUserForEmail ??
        (await tx.user
          .create({
            data: {
              email: invitation.invitedEmail,
              fullName: invitation.invitedEmail,
              status: "PENDING_ACTIVATION",
              createdById: invitation.invitedById,
            },
          })
          .catch((error) => {
            if (isExpectedUniqueViolation(error, ["email"])) {
              throw new ConflictException({
                code: "INVITATION_ALREADY_ACCEPTED",
                message: "This invitation has already been accepted.",
                source: "unique_constraint_fallback",
              });
            }
            throw error;
          }));

      // Step 5: create membership. Same reasoning as step 4 — the
      // same-token race is closed by the lock; this catch remains
      // reachable only for two different invitation tokens targeting the
      // same email for the same workspace, accepted concurrently.
      await tx.workspaceMember
        .create({
          data: {
            workspaceId: invitation.workspaceId,
            userId: targetUser.id,
            roleId: invitation.roleId,
            status: "PENDING_ACTIVATION",
            invitedById: invitation.invitedById,
          },
        })
        .catch((error) => {
          if (isExpectedUniqueViolation(error, ["workspace_id", "user_id"])) {
            throw new ConflictException({
              code: "INVITATION_ALREADY_ACCEPTED",
              message: "This invitation has already been accepted.",
              source: "unique_constraint_fallback",
            });
          }
          throw error;
        });

      // Step 6: update invitation to ACCEPTED.
      await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedById: targetUser.id, acceptedAt: new Date() },
      });

      // Step 7: issue activation token where applicable. A PENDING
      // ACCOUNT_ACTIVATION token may already exist for this user (from an
      // earlier invitation) — don't rotate/invalidate it just because a
      // second workspace also invited them; the existing token will
      // activate every pending membership, this one included, once
      // consumed. Only issue a fresh one if none is currently valid.
      // Issued within THIS transaction, not a separate one — the new
      // user/membership and their activation token either all commit
      // together or none of them do. See InvitationActivationService for
      // why that matters: a failure issuing the token in a separate
      // transaction previously left a PENDING_ACTIVATION user permanently
      // stuck with no valid way to ever activate.
      const existingPendingToken = await tx.userActionToken.findFirst({
        where: { userId: targetUser.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING", expiresAt: { gt: new Date() } },
      });
      const issuedToken = existingPendingToken
        ? null
        : await this.activation.issueActivationTokenWithinTransaction(tx, targetUser.id, {
            initiatingWorkspacePublicId: workspace.publicId,
            workspaceNameForEmail: workspace.name,
            reason: "invitation_accepted",
          });

      // Step 8: write audit events.
      if (!currentUserForEmail) {
        await this.audit.recordWithinTransaction(tx, {
          action: "USER_CREATED",
          actorUserId: invitation.invitedById,
          entityType: "user",
          entityId: targetUser.publicId,
          ipAddress: context.ipAddress,
        });
      }
      await this.audit.recordWithinTransaction(tx, {
        action: "WORKSPACE_MEMBER_PENDING_ACTIVATION",
        actorUserId: invitation.invitedById,
        workspaceId: invitation.workspaceId,
        entityType: "workspace_member",
        entityId: targetUser.publicId,
        ipAddress: context.ipAddress,
      });

      // Step 9: commit atomically — implicit, end of transaction callback.
      if (existingPendingToken) {
        return { requiresActivation: true as const, alreadyHasValidToken: true as const };
      }
      return {
        requiresActivation: true as const,
        alreadyHasValidToken: false as const,
        issuedToken: issuedToken!,
        workspaceName: workspace.name,
      };
    });

    if (result.requiresActivation && !result.alreadyHasValidToken) {
      await this.activation.sendActivationEmail(result.issuedToken, result.workspaceName);
    }

    return { requiresActivation: result.requiresActivation };
  }

  private async requireMatchingSession(tx: Prisma.TransactionClient, sessionUserPublicId: string | null, invitedUserId: string) {
    if (!sessionUserPublicId) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Sign in to accept this invitation." });
    }
    const sessionUser = await tx.user.findFirst({ where: { publicId: sessionUserPublicId, deletedAt: null } });
    if (!sessionUser || sessionUser.id !== invitedUserId) {
      throw new ForbiddenException({ code: "EMAIL_MISMATCH", message: "This invitation was issued to a different account." });
    }
    if (sessionUser.status !== "ACTIVE") {
      throw new GoneException({ code: "INVITATION_TARGET_UNAVAILABLE", message: "The invited account is no longer available." });
    }
    return sessionUser;
  }

  private async requireMatchingSessionByEmail(tx: Prisma.TransactionClient, sessionUserPublicId: string | null, invitedEmail: string) {
    if (!sessionUserPublicId) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Sign in to accept this invitation." });
    }
    const sessionUser = await tx.user.findFirst({ where: { publicId: sessionUserPublicId, deletedAt: null } });
    if (!sessionUser || sessionUser.email !== invitedEmail || sessionUser.status !== "ACTIVE") {
      throw new ForbiddenException({ code: "EMAIL_MISMATCH", message: "This invitation was issued to a different account." });
    }
    return sessionUser;
  }

  /**
   * workspace_members has UNIQUE(workspaceId, userId) — re-joining after a
   * prior REMOVED updates that row in place, never a duplicate insert.
   *
   * Module 1C.1 final concurrency correction: the same-token race this
   * originally guarded against (two concurrent accept() calls for one
   * invitation, both observing `existing === null`) is now closed by the
   * invitation-row lock in accept() — a second request for the same token
   * blocks there and is rejected at the post-lock status re-check before
   * it ever reaches this method. This catch stays reachable only for two
   * *different* invitation tokens for the same workspace+user resolving
   * concurrently (no shared lock between different invitation rows).
   * Narrowed to the workspace_members(workspace_id,user_id) constraint via
   * error.meta.target.
   */
  private async joinAsActive(
    tx: Prisma.TransactionClient,
    invitation: LockedInvitationRow,
    userId: string,
    context: RequestContext,
  ): Promise<void> {
    const existing = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invitation.workspaceId, userId } },
    });
    if (existing) {
      await tx.workspaceMember.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", roleId: invitation.roleId, joinedAt: new Date(), invitedById: invitation.invitedById },
      });
    } else {
      await tx.workspaceMember
        .create({
          data: {
            workspaceId: invitation.workspaceId,
            userId,
            roleId: invitation.roleId,
            status: "ACTIVE",
            joinedAt: new Date(),
            invitedById: invitation.invitedById,
          },
        })
        .catch((error) => {
          if (isExpectedUniqueViolation(error, ["workspace_id", "user_id"])) {
            throw new ConflictException({
              code: "INVITATION_ALREADY_ACCEPTED",
              message: "This invitation has already been accepted.",
              source: "unique_constraint_fallback",
            });
          }
          throw error;
        });
    }
    await tx.workspaceInvitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED", acceptedById: userId, acceptedAt: new Date() },
    });
    await this.audit.recordWithinTransaction(tx, {
      action: "WORKSPACE_MEMBER_JOINED",
      actorUserId: userId,
      workspaceId: invitation.workspaceId,
      entityType: "workspace_member",
      entityId: userId,
      ipAddress: context.ipAddress,
    });
  }
}
