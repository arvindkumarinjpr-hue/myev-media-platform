import { Injectable, Logger } from "@nestjs/common";
import type { AuditAction, Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";

export interface AuditEventInput {
  action: AuditAction;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  ipAddress?: string;
  requestId?: string;
  correlationId?: string;
}

/**
 * Append-only by construction: this service only ever calls `create` on
 * the audit_logs table, never `update`/`delete` — the Prisma model itself
 * has no `deletedAt` field, so there is no code path that could soften
 * this into a mutable log even by mistake.
 *
 * Two write modes (Module 1B.1 Engineering Plan §9):
 *  - `record()` — routine events (LOGIN_SUCCESS/FAILED, LOGOUT,
 *    TOKEN_REFRESHED). Best-effort: a persistence failure never blocks the
 *    underlying auth action, but is logged as a high-severity alert.
 *  - `recordWithinTransaction()` — high-stakes security mutations
 *    (PASSWORD_RESET_COMPLETED, PASSWORD_CHANGED, TOKEN_REUSE_DETECTED,
 *    ACCOUNT_LOCKED). Part of the same atomic transaction as the mutation
 *    — if this fails, the whole operation rolls back.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(event: AuditEventInput): Promise<void> {
    try {
      await this.prisma.auditLog.create({ data: this.toRow(event) });
    } catch (error) {
      this.logger.error({
        alertSeverity: "HIGH",
        event: "AUDIT_WRITE_FAILED",
        auditAction: event.action,
        err: (error as Error).message,
      });
    }
  }

  async recordWithinTransaction(
    tx: Prisma.TransactionClient,
    event: AuditEventInput,
  ): Promise<void> {
    await tx.auditLog.create({ data: this.toRow(event) });
  }

  private toRow(event: AuditEventInput) {
    return {
      action: event.action,
      actorUserId: event.actorUserId ?? null,
      entityType: event.entityType,
      entityId: event.entityId,
      // Masking: callers must never pass password/token values in
      // beforeState/afterState — see field-level guidance in each caller.
      beforeState: event.beforeState as Prisma.InputJsonValue | undefined,
      afterState: event.afterState as Prisma.InputJsonValue | undefined,
      ipAddress: event.ipAddress,
      requestId: event.requestId,
      correlationId: event.correlationId,
    };
  }
}
