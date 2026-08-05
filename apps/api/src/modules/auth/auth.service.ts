import { BadRequestException, ForbiddenException, GoneException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Prisma, RevokedReason, User, UserSession } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { PasswordHashService } from "../../common/crypto/password-hash.service";
import { PasswordPolicyService } from "../../common/crypto/password-policy.service";
import { TokenService } from "../../common/crypto/token.service";
import { AdaptiveProtectionService } from "../../common/rate-limit/adaptive-protection.service";
import { AuditService } from "../audit/audit.service";
import { EMAIL_PROVIDER, type EmailProvider } from "../email/email-provider.interface";
import { UsersService } from "../users/users.service";
import type { AppConfig } from "../../config/configuration";
import type { AccessTokenPayload } from "./access-token.payload";
import { SessionsService, type SessionContext } from "./sessions.service";

const REUSE_GRACE_WINDOW_MS = 10_000;

export interface LoginResult {
  accessToken: string;
  refreshTokenPlaintext: string;
  user: Pick<User, "publicId" | "email" | "fullName">;
}

// Discriminated result for the refresh transaction — see the comment in
// `refresh()` for why branches return this instead of throwing.
type RefreshOutcome =
  | { kind: "success"; tokens: { accessToken: string; refreshTokenPlaintext: string } }
  | { kind: "invalid" }
  | { kind: "expired" }
  | { kind: "rotation_in_progress" }
  | { kind: "reuse_detected" };

@Injectable()
export class AuthService {
  /**
   * A fixed, precomputed Argon2id hash of a value nobody will ever submit
   * as a real password — used only so a login attempt against a
   * non-existent email still runs a real `verify()` call, keeping the
   * timing profile of "no such user" indistinguishable from "wrong
   * password" (enumeration safety, Module 1B.1 Engineering Plan §7/§18).
   * Computed once at startup, not per-request.
   */
  private dummyHash: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly sessionsService: SessionsService,
    private readonly passwordHashService: PasswordHashService,
    private readonly passwordPolicyService: PasswordPolicyService,
    private readonly tokenService: TokenService,
    private readonly protection: AdaptiveProtectionService,
    private readonly audit: AuditService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
  ) {}

  async login(email: string, password: string, context: SessionContext): Promise<LoginResult> {
    const auth = this.config.get("auth", { infer: true });
    const lockKey = email.toLowerCase();

    if (await this.protection.isLocked(lockKey, auth.failedLoginThreshold)) {
      await this.audit.record({ action: "LOGIN_FAILED", entityType: "user", ipAddress: context.ipAddress });
      throw new ForbiddenException({ code: "AUTH_ACCOUNT_LOCKED", message: "Account is temporarily locked. Try again later." });
    }

    const user = await this.usersService.findByEmail(email);
    const genericInvalidCredentials = () =>
      new UnauthorizedException({ code: "AUTH_INVALID_CREDENTIALS", message: "Invalid email or password." });

    // Enumeration-safe: always run a real verify() call, even for a
    // non-existent user, against the precomputed dummy hash.
    const hashToVerifyAgainst = user?.passwordHash ?? (await this.getDummyHash());
    const passwordValid = await this.passwordHashService.verify(hashToVerifyAgainst, password);

    if (!user || !user.passwordHash || !passwordValid) {
      const lock = await this.protection.recordFailedAttempt(lockKey, auth.failedLoginThreshold, auth.lockWindowSeconds);
      await this.audit.record({
        action: "LOGIN_FAILED",
        actorUserId: user?.id,
        entityType: "user",
        entityId: user?.publicId,
        ipAddress: context.ipAddress,
      });
      if (lock.locked) {
        await this.audit.record({ action: "ACCOUNT_LOCKED", actorUserId: user?.id, entityType: "user", entityId: user?.publicId });
      }
      throw genericInvalidCredentials();
    }

    if (user.status === "DISABLED") {
      throw new ForbiddenException({ code: "AUTH_ACCOUNT_DISABLED", message: "This account has been disabled." });
    }
    if (user.status === "PENDING_ACTIVATION") {
      // Unreachable in practice — a PENDING_ACTIVATION user has no
      // password_hash, so passwordValid above is already false. Guarded
      // explicitly anyway so this invariant is enforced even if that
      // changes later.
      throw genericInvalidCredentials();
    }

    await this.protection.clearAttempts(lockKey);
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const { session, refreshTokenPlaintext } = await this.sessionsService.createFamily(user.id, context);
    const accessToken = this.signAccessToken(user, session);

    await this.audit.record({
      action: "LOGIN_SUCCESS",
      actorUserId: user.id,
      entityType: "user",
      entityId: user.publicId,
      ipAddress: context.ipAddress,
    });

    return {
      accessToken,
      refreshTokenPlaintext,
      user: { publicId: user.publicId, email: user.email, fullName: user.fullName },
    };
  }

  async refresh(refreshTokenPlaintext: string, context: SessionContext): Promise<{ accessToken: string; refreshTokenPlaintext: string }> {
    const presentedHash = this.tokenService.hashToken(refreshTokenPlaintext);

    // Throwing inside a Prisma interactive transaction callback rolls back
    // every write made in it — including the family-revocation / expiry
    // writes that reuse detection depends on. So every branch below
    // *returns* an outcome and lets the transaction commit normally; the
    // corresponding exception is only thrown after `$transaction` resolves.
    const outcome = await this.prisma.$transaction(async (tx): Promise<RefreshOutcome> => {
      const session = await this.sessionsService.findByRefreshTokenHashWithinTransaction(tx, presentedHash);
      if (!session) {
        return { kind: "invalid" };
      }

      if (session.status === "ACTIVE") {
        return this.rotateActiveSession(tx, session, context);
      }

      if (session.status === "ROTATED") {
        // Presented again very shortly after rotation: treat as a benign
        // concurrent retry (Module 1B.1 Engineering Plan §13 "concurrent
        // refresh race condition"), not an attack.
        const child = await tx.userSession.findFirst({ where: { parentSessionId: session.id } });
        const withinGraceWindow = child ? Date.now() - child.issuedAt.getTime() < REUSE_GRACE_WINDOW_MS : false;

        if (child && withinGraceWindow) {
          // The original plaintext refresh token from the winning request
          // is never available here (only its hash is ever stored) — the
          // losing concurrent request is told to retry, by which point the
          // winner's new token is already usable client-side.
          return { kind: "rotation_in_progress" };
        }

        await this.handleReuseDetected(tx, session, context);
        return { kind: "reuse_detected" };
      }

      // REVOKED or EXPIRED presented again — unambiguous reuse.
      await this.handleReuseDetected(tx, session, context);
      return { kind: "reuse_detected" };
    });

    switch (outcome.kind) {
      case "success":
        return outcome.tokens;
      case "invalid":
        throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Refresh token is invalid." });
      case "expired":
        throw new UnauthorizedException({ code: "AUTH_TOKEN_EXPIRED", message: "Refresh token has expired." });
      case "rotation_in_progress":
        throw new UnauthorizedException({
          code: "AUTH_TOKEN_ROTATION_IN_PROGRESS",
          message: "This refresh token was already rotated moments ago by a concurrent request. Retry with the new token.",
        });
      case "reuse_detected":
        throw new UnauthorizedException({ code: "AUTH_TOKEN_REUSE_DETECTED", message: "Refresh token is invalid." });
    }
  }

  async logout(sessionPublicId: string): Promise<void> {
    const session = await this.sessionsService.findByPublicId(sessionPublicId);
    // Idempotent: an already-revoked/unknown session still returns
    // successfully — the end state (logged out) is already achieved.
    if (session && session.status !== "REVOKED") {
      await this.sessionsService.revokeSession(session.id, "LOGOUT");
    }
    await this.audit.record({ action: "LOGOUT", entityId: sessionPublicId, entityType: "session" });
  }

  async forgotPassword(email: string, context: SessionContext): Promise<void> {
    const auth = this.config.get("auth", { infer: true });
    const user = await this.usersService.findByEmail(email);

    // Enumeration-safe: the controller always returns the same generic
    // response regardless of what happens in here. Only a real, active
    // user triggers a real token/email/audit-event.
    if (user && user.status === "ACTIVE") {
      const plaintext = this.tokenService.generateOpaqueToken();
      const tokenHash = this.tokenService.hashToken(plaintext);

      await this.prisma.$transaction(async (tx) => {
        await tx.userActionToken.updateMany({
          where: { userId: user.id, purpose: "PASSWORD_RESET", status: "PENDING" },
          data: { status: "INVALIDATED" },
        });
        await tx.userActionToken.create({
          data: {
            userId: user.id,
            purpose: "PASSWORD_RESET",
            tokenHash,
            expiresAt: new Date(Date.now() + auth.resetTokenTtlSeconds * 1000),
            requestedIp: context.ipAddress,
          },
        });
      });

      await this.audit.record({
        action: "PASSWORD_RESET_REQUESTED",
        actorUserId: user.id,
        entityType: "user",
        entityId: user.publicId,
        ipAddress: context.ipAddress,
      });

      const resetUrl = `${this.config.get("appUrl", { infer: true })}/reset-password?token=${plaintext}`;
      await this.emailProvider.send(user.email, "PASSWORD_RESET", {
        recipientName: user.fullName,
        resetUrl,
        expiresInMinutes: Math.round(auth.resetTokenTtlSeconds / 60),
      });
    }
  }

  /**
   * Consumes a one-time token (password reset OR account activation — the
   * same underlying operation: verify token, set password, per Module
   * 1B.1 Engineering Plan §4's consolidated `user_action_tokens` design).
   * Activation additionally flips PENDING_ACTIVATION -> ACTIVE.
   */
  async resetPassword(tokenPlaintext: string, newPassword: string): Promise<void> {
    this.passwordPolicyService.assertValid(newPassword);
    const tokenHash = this.tokenService.hashToken(tokenPlaintext);

    await this.prisma.$transaction(async (tx) => {
      const token = await tx.userActionToken.findUnique({ where: { tokenHash } });
      if (!token) {
        throw new BadRequestException({ code: "AUTH_RESET_TOKEN_INVALID", message: "Link is invalid." });
      }
      if (token.status !== "PENDING") {
        throw new GoneException({ code: "AUTH_RESET_TOKEN_INVALID", message: "Link has already been used." });
      }
      if (token.expiresAt < new Date()) {
        await tx.userActionToken.update({ where: { id: token.id }, data: { status: "EXPIRED" } });
        throw new GoneException({ code: "AUTH_RESET_TOKEN_EXPIRED", message: "Link has expired." });
      }

      const isActivation = token.purpose === "ACCOUNT_ACTIVATION";

      if (!isActivation && (await this.usersService.isPasswordReused(token.userId, newPassword))) {
        throw new BadRequestException({ code: "PASSWORD_REUSE_DETECTED", message: "You've used this password recently. Choose a different one." });
      }

      const newHash = await this.passwordHashService.hash(newPassword);
      await this.usersService.setPasswordWithinTransaction(tx, token.userId, newHash);
      await tx.userActionToken.update({ where: { id: token.id }, data: { status: "USED", usedAt: new Date() } });

      if (isActivation) {
        await tx.user.update({ where: { id: token.userId }, data: { status: "ACTIVE", activatedAt: new Date() } });
      } else {
        await this.sessionsService.revokeAllForUserWithinTransaction(tx, token.userId, "PASSWORD_RESET");
      }

      await this.audit.recordWithinTransaction(tx, {
        action: isActivation ? "ACCOUNT_ACTIVATED" : "PASSWORD_RESET_COMPLETED",
        actorUserId: token.userId,
        entityType: "user",
        entityId: token.userId,
        afterState: isActivation ? { status: "ACTIVE" } : undefined,
      });
    });
  }

  async changePassword(userId: string, currentSessionId: string, currentPassword: string, newPassword: string): Promise<void> {
    this.passwordPolicyService.assertValid(newPassword);
    const user = await this.usersService.findById(userId);
    if (!user?.passwordHash || !(await this.passwordHashService.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException({ code: "AUTH_INVALID_CREDENTIALS", message: "Current password is incorrect." });
    }
    if (await this.usersService.isPasswordReused(userId, newPassword)) {
      throw new BadRequestException({ code: "PASSWORD_REUSE_DETECTED", message: "You've used this password recently. Choose a different one." });
    }

    await this.prisma.$transaction(async (tx) => {
      const newHash = await this.passwordHashService.hash(newPassword);
      await this.usersService.setPasswordWithinTransaction(tx, userId, newHash);
      await this.sessionsService.revokeOtherSessionsForUserWithinTransaction(tx, userId, currentSessionId, "PASSWORD_CHANGE");
      await this.audit.recordWithinTransaction(tx, {
        action: "PASSWORD_CHANGED",
        actorUserId: userId,
        entityType: "user",
        entityId: user.publicId,
      });
    });
  }

  private async rotateActiveSession(
    tx: Prisma.TransactionClient,
    session: UserSession,
    context: SessionContext,
  ): Promise<RefreshOutcome> {
    const now = new Date();
    if (session.expiresAt < now || session.familyExpiresAt < now) {
      await this.sessionsService.revokeSessionWithinTransaction(tx, session.id, "EXPIRED");
      return { kind: "expired" };
    }

    await this.sessionsService.markRotated(tx, session.id);
    const { session: newSession, refreshTokenPlaintext } = await this.sessionsService.rotateWithinTransaction(tx, session, context);

    const user = await tx.user.findUniqueOrThrow({ where: { id: session.userId } });
    const accessToken = this.signAccessToken(user, newSession);

    await this.audit.recordWithinTransaction(tx, {
      action: "TOKEN_REFRESHED",
      actorUserId: session.userId,
      entityType: "session",
      entityId: newSession.publicId,
      ipAddress: context.ipAddress,
    });

    return { kind: "success", tokens: { accessToken, refreshTokenPlaintext } };
  }

  private async handleReuseDetected(tx: Prisma.TransactionClient, session: UserSession, context: SessionContext): Promise<void> {
    const revokedCount = await this.sessionsService.revokeFamilyWithinTransaction(
      tx,
      session.familyId,
      "REUSE_DETECTED" as RevokedReason,
    );
    await this.audit.recordWithinTransaction(tx, {
      action: "TOKEN_REUSE_DETECTED",
      actorUserId: session.userId,
      entityType: "session_family",
      entityId: session.familyId,
      ipAddress: context.ipAddress,
      afterState: { revokedSessionCount: revokedCount },
    });
  }

  private signAccessToken(user: Pick<User, "publicId">, session: Pick<UserSession, "publicId" | "familyId">): string {
    const payload: AccessTokenPayload = { sub: user.publicId, sessionId: session.publicId, familyId: session.familyId };
    return this.jwtService.sign(payload);
  }

  private async getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      this.dummyHash = await this.passwordHashService.hash("dummy-password-for-timing-safety-only");
    }
    return this.dummyHash;
  }
}
