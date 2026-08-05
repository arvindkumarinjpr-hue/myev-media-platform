import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Inject,
  Injectable,
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
      const invitation = await tx.workspaceInvitation.findUnique({ where: { tokenHash } });
      if (!invitation) {
        throw new BadRequestException({ code: "INVITATION_INVALID", message: "This invitation link is invalid." });
      }
      if (invitation.status !== "PENDING") {
        throw new GoneException({ code: "INVITATION_INVALID", message: "This invitation has already been used or revoked." });
      }
      if (invitation.expiresAt < new Date()) {
        await tx.workspaceInvitation.update({ where: { id: invitation.id }, data: { status: "EXPIRED" } });
        throw new GoneException({ code: "INVITATION_EXPIRED", message: "This invitation has expired." });
      }

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

      // A user for this email may already exist as PENDING_ACTIVATION —
      // invited to a *different* workspace first, still mid-onboarding.
      // Reuse that same account rather than attempting a second
      // tx.user.create() with the same email: the whole point of user-
      // level activation tokens (Module 1C Engineering Plan §3) is that one
      // eventual activation must cover every workspace this person was
      // invited to, not just whichever came first.
      //
      // Module 1C.1 defect patch: this branch is reached by a fresh read
      // of currentUserForEmail above, so two concurrent accept() calls
      // that both observe "no user yet" can both reach this create() before
      // either commits — the database's own UNIQUE(email) constraint is
      // what actually serializes them. Narrow catch: only a P2002 from
      // THIS exact insert is translated to a clean conflict; every other
      // failure in this transaction is untouched, and no Prisma error
      // detail ever reaches the client. Nothing has been written yet in
      // this transaction at this point, so the rollback this throw causes
      // discards no state that needed to survive.
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
            if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
              throw new ConflictException({
                code: "INVITATION_ALREADY_ACCEPTED",
                message: "This invitation has already been accepted.",
              });
            }
            throw error;
          }));

      if (!currentUserForEmail) {
        await this.audit.recordWithinTransaction(tx, {
          action: "USER_CREATED",
          actorUserId: invitation.invitedById,
          entityType: "user",
          entityId: targetUser.publicId,
          ipAddress: context.ipAddress,
        });
      }

      await tx.workspaceMember.create({
        data: {
          workspaceId: invitation.workspaceId,
          userId: targetUser.id,
          roleId: invitation.roleId,
          status: "PENDING_ACTIVATION",
          invitedById: invitation.invitedById,
        },
      });
      await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: { status: "ACCEPTED", acceptedById: targetUser.id, acceptedAt: new Date() },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "WORKSPACE_MEMBER_PENDING_ACTIVATION",
        actorUserId: invitation.invitedById,
        workspaceId: invitation.workspaceId,
        entityType: "workspace_member",
        entityId: targetUser.publicId,
        ipAddress: context.ipAddress,
      });

      // A PENDING ACCOUNT_ACTIVATION token may already exist for this user
      // (from an earlier invitation) — don't rotate/invalidate it just
      // because a second workspace also invited them; the existing token
      // will activate every pending membership, this one included, once
      // consumed. Only issue a fresh one if none is currently valid.
      const existingPendingToken = await tx.userActionToken.findFirst({
        where: { userId: targetUser.id, purpose: "ACCOUNT_ACTIVATION", status: "PENDING", expiresAt: { gt: new Date() } },
      });
      if (existingPendingToken) {
        return { requiresActivation: true as const, alreadyHasValidToken: true as const };
      }

      // Issued within THIS transaction, not a separate one — the new
      // user/membership and their activation token either all commit
      // together or none of them do. See InvitationActivationService for
      // why that matters: a failure issuing the token in a separate
      // transaction previously left a PENDING_ACTIVATION user permanently
      // stuck with no valid way to ever activate.
      const issuedToken = await this.activation.issueActivationTokenWithinTransaction(tx, targetUser.id, {
        initiatingWorkspacePublicId: workspace.publicId,
        workspaceNameForEmail: workspace.name,
        reason: "invitation_accepted",
      });

      return { requiresActivation: true as const, alreadyHasValidToken: false as const, issuedToken, workspaceName: workspace.name };
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
   * Module 1C.1 defect patch: this is the existing-ACTIVE-user counterpart
   * to the new-user race fixed in accept() above — two concurrent accept()
   * calls presenting the same session (e.g. a double-submitted click) can
   * both observe `existing === null` and both reach this create() before
   * either commits. Same narrow fix: only a P2002 from THIS insert is
   * translated, on the same UNIQUE(workspace_id, user_id) constraint this
   * branch's own preceding findUnique already checked (racily). Nothing
   * has been written yet in this transaction at this point.
   */
  private async joinAsActive(
    tx: Prisma.TransactionClient,
    invitation: WorkspaceInvitation,
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
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === UNIQUE_CONSTRAINT_VIOLATION) {
            throw new ConflictException({
              code: "INVITATION_ALREADY_ACCEPTED",
              message: "This invitation has already been accepted.",
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
