import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma, User } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { PasswordHashService } from "../../common/crypto/password-hash.service";
import type { AppConfig } from "../../config/configuration";

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHashService: PasswordHashService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: email.toLowerCase(), deletedAt: null } });
  }

  findByPublicId(publicId: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { publicId, deletedAt: null } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  /**
   * Controlled user creation only — there is no public self-registration
   * endpoint (Module 1B.1 Engineering Plan §18 decision #1 / Blueprint
   * exclusion). In 1B.1 this is reachable only via the seed script's
   * bootstrap-owner path, not an HTTP endpoint; a real Owner/Admin-invoked
   * HTTP endpoint is deferred to Module 1C, once workspace-scoped Admin
   * permission checks are real.
   */
  async createPendingActivationUser(params: {
    email: string;
    fullName: string;
    createdById?: string | null;
  }): Promise<User> {
    return this.prisma.user.create({
      data: {
        email: params.email.toLowerCase(),
        fullName: params.fullName,
        status: "PENDING_ACTIVATION",
        createdById: params.createdById ?? null,
      },
    });
  }

  /** Last-5 password reuse check (Module 1B.1 Engineering Plan §7). */
  async isPasswordReused(userId: string, candidatePlaintext: string): Promise<boolean> {
    const limit = this.config.get("auth", { infer: true }).passwordHistoryLimit;
    const history = await this.prisma.userPasswordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    for (const entry of history) {
      if (await this.passwordHashService.verify(entry.passwordHash, candidatePlaintext)) {
        return true;
      }
    }
    return false;
  }

  /** Sets a new password and appends to history, within a caller-supplied transaction. */
  async setPasswordWithinTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    newPasswordHash: string,
  ): Promise<void> {
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash: newPasswordHash },
    });
    await tx.userPasswordHistory.create({
      data: { userId, passwordHash: newPasswordHash },
    });
    await this.prunePasswordHistory(tx, userId);
  }

  private async prunePasswordHistory(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const limit = this.config.get("auth", { infer: true }).passwordHistoryLimit;
    const rows = await tx.userPasswordHistory.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      skip: limit,
      select: { id: true },
    });
    if (rows.length > 0) {
      await tx.userPasswordHistory.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } });
    }
  }
}
