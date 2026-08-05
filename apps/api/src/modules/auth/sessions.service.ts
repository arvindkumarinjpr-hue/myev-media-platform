import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import type { Prisma, RevokedReason, UserSession } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { TokenService } from "../../common/crypto/token.service";
import type { AppConfig } from "../../config/configuration";
import { computeSessionFingerprint, parseDeviceMetadata } from "./device.util";

export interface SessionContext {
  ipAddress?: string;
  userAgent?: string;
}

export interface IssuedSession {
  session: UserSession;
  refreshTokenPlaintext: string;
}

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  /** New login — starts a brand-new rotation family. */
  async createFamily(userId: string, context: SessionContext): Promise<IssuedSession> {
    const auth = this.config.get("auth", { infer: true });
    const familyId = randomUUID();
    return this.createSessionRow({
      userId,
      familyId,
      parentSessionId: null,
      context,
      refreshTtlSeconds: auth.refreshTokenTtlSeconds,
      familyExpiresAt: new Date(Date.now() + auth.familyTtlSeconds * 1000),
    });
  }

  /** Rotation — same family, new token, linked to its parent. */
  async rotateWithinTransaction(
    tx: Prisma.TransactionClient,
    parent: UserSession,
    context: SessionContext,
  ): Promise<IssuedSession> {
    const auth = this.config.get("auth", { infer: true });
    return this.createSessionRow(
      {
        userId: parent.userId,
        familyId: parent.familyId,
        parentSessionId: parent.id,
        context,
        refreshTtlSeconds: auth.refreshTokenTtlSeconds,
        familyExpiresAt: parent.familyExpiresAt,
      },
      tx,
    );
  }

  findByRefreshTokenHash(hash: string): Promise<UserSession | null> {
    return this.prisma.userSession.findUnique({ where: { refreshTokenHash: hash } });
  }

  findByRefreshTokenHashWithinTransaction(tx: Prisma.TransactionClient, hash: string): Promise<UserSession | null> {
    // SELECT ... FOR UPDATE — serializes concurrent refresh calls on the
    // same token so rotation + reuse-detection is atomic (Module 1B.1
    // Engineering Plan §11, §13 "concurrent refresh race condition").
    //
    // Raw queries bypass Prisma's column mapping, so every snake_case
    // column is aliased here to its exact camelCase field name — without
    // this, the returned rows have `user_id`/`family_id`/etc. instead of
    // `userId`/`familyId`/etc., and callers reading `session.userId` get
    // `undefined` (this broke session rotation until it was caught).
    return tx.$queryRaw<UserSession[]>`
      SELECT
        id,
        public_id AS "publicId",
        user_id AS "userId",
        family_id AS "familyId",
        parent_session_id AS "parentSessionId",
        refresh_token_hash AS "refreshTokenHash",
        status,
        issued_at AS "issuedAt",
        expires_at AS "expiresAt",
        family_expires_at AS "familyExpiresAt",
        revoked_at AS "revokedAt",
        revoked_reason AS "revokedReason",
        ip_address AS "ipAddress",
        user_agent AS "userAgent",
        device_name AS "deviceName",
        browser,
        operating_system AS "operatingSystem",
        platform,
        last_seen_at AS "lastSeenAt",
        device_fingerprint AS "deviceFingerprint",
        session_fingerprint AS "sessionFingerprint",
        created_at AS "createdAt"
      FROM user_sessions WHERE refresh_token_hash = ${hash} FOR UPDATE
    `.then((rows) => rows[0] ?? null);
  }

  findByPublicId(publicId: string): Promise<UserSession | null> {
    return this.prisma.userSession.findUnique({ where: { publicId } });
  }

  async markRotated(tx: Prisma.TransactionClient, sessionId: string): Promise<void> {
    await tx.userSession.update({
      where: { id: sessionId },
      data: { status: "ROTATED" },
    });
  }

  async revokeSession(sessionId: string, reason: RevokedReason): Promise<void> {
    await this.prisma.userSession.update({
      where: { id: sessionId },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason },
    });
  }

  async revokeSessionWithinTransaction(
    tx: Prisma.TransactionClient,
    sessionId: string,
    reason: RevokedReason,
  ): Promise<void> {
    await tx.userSession.update({
      where: { id: sessionId },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** Revokes every non-terminal session in a family — reuse detection. */
  async revokeFamilyWithinTransaction(
    tx: Prisma.TransactionClient,
    familyId: string,
    reason: RevokedReason,
  ): Promise<number> {
    const result = await tx.userSession.updateMany({
      where: { familyId, status: { in: ["ACTIVE", "ROTATED"] } },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason },
    });
    return result.count;
  }

  /** All of a user's sessions — password reset. */
  async revokeAllForUserWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    reason: RevokedReason,
  ): Promise<void> {
    await tx.userSession.updateMany({
      where: { userId, status: { in: ["ACTIVE", "ROTATED"] } },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason },
    });
  }

  /** All except one — password change (current session stays alive). */
  async revokeOtherSessionsForUserWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    keepSessionId: string,
    reason: RevokedReason,
  ): Promise<void> {
    await tx.userSession.updateMany({
      where: { userId, id: { not: keepSessionId }, status: { in: ["ACTIVE", "ROTATED"] } },
      data: { status: "REVOKED", revokedAt: new Date(), revokedReason: reason },
    });
  }

  private async createSessionRow(
    params: {
      userId: string;
      familyId: string;
      parentSessionId: string | null;
      context: SessionContext;
      refreshTtlSeconds: number;
      familyExpiresAt: Date;
    },
    tx?: Prisma.TransactionClient,
  ): Promise<IssuedSession> {
    const client = tx ?? this.prisma;
    const refreshTokenPlaintext = this.tokenService.generateOpaqueToken();
    const refreshTokenHash = this.tokenService.hashToken(refreshTokenPlaintext);
    const device = parseDeviceMetadata(params.context.userAgent);
    const sessionFingerprint = computeSessionFingerprint(params.context.ipAddress, params.context.userAgent);

    const session = await client.userSession.create({
      data: {
        userId: params.userId,
        familyId: params.familyId,
        parentSessionId: params.parentSessionId,
        refreshTokenHash,
        expiresAt: new Date(Date.now() + params.refreshTtlSeconds * 1000),
        familyExpiresAt: params.familyExpiresAt,
        ipAddress: params.context.ipAddress,
        userAgent: params.context.userAgent,
        deviceName: device.deviceName,
        browser: device.browser,
        operatingSystem: device.operatingSystem,
        platform: device.platform,
        sessionFingerprint,
        // deviceFingerprint intentionally left null — no frontend exists
        // yet to supply a client-side fingerprint (Refinement 3).
      },
    });

    return { session, refreshTokenPlaintext };
  }
}
