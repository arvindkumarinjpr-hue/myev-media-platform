import { Injectable } from "@nestjs/common";
import type { AdvisoryLockAcquirer, ProcessedEventReaderWriter, ProcessedEventStore, TransactionRunner } from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import { Prisma } from "../../../api/generated/prisma";

/**
 * Milestone 8.3 Phase 4 — concrete adapters binding the Phase 1
 * framework-independent runtime interfaces (packages/shared) to this
 * process's real PrismaService. Plain classes, not lifecycle
 * participants: no OnApplicationBootstrap/Shutdown, no Redis, no BullMQ,
 * no timer, no resource ownership beyond PrismaService itself (already
 * owned elsewhere). Not registered in any production module — Phase 4
 * wires them only inside the test-local TestingModule; a future phase
 * that needs them in production DI can add that wiring then.
 */
@Injectable()
export class PrismaTransactionRunner implements TransactionRunner<Prisma.TransactionClient> {
  constructor(private readonly prisma: PrismaService) {}

  run<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(fn);
  }
}

/**
 * Milestone 8.3 FINAL ARCHITECTURE FREEZE §5 — transaction-scoped
 * ownership for (domainEventId, consumerName), reusing the exact
 * pg_advisory_xact_lock primitive already established in this codebase
 * (apps/api/src/modules/platform-owner/platform-owner.seed.ts's own
 * single-key lock), extended here to a dynamic composite key via the
 * two-argument overload: hashtext() on each half, computed by Postgres
 * itself inside the parameterized raw statement — no manual bit-packing
 * in application code. Blocks (never a try-lock) until acquired,
 * auto-released at this transaction's own commit/rollback — never a
 * separate unlock call.
 */
@Injectable()
export class PrismaAdvisoryLockAcquirer implements AdvisoryLockAcquirer<Prisma.TransactionClient> {
  async acquire(tx: Prisma.TransactionClient, domainEventId: string, consumerName: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${domainEventId}), hashtext(${consumerName}))`;
  }
}

@Injectable()
export class PrismaProcessedEventReaderWriter implements ProcessedEventReaderWriter<Prisma.TransactionClient> {
  find(tx: Prisma.TransactionClient, eventId: string, consumerName: string): Promise<{ id: string } | null> {
    return tx.processedEvent.findUnique({ where: { eventId_consumerName: { eventId, consumerName } }, select: { id: true } });
  }

  async create(tx: Prisma.TransactionClient, eventId: string, consumerName: string): Promise<void> {
    await tx.processedEvent.create({ data: { eventId, consumerName } });
  }
}

/** Category B — no transaction parameter anywhere, matching ProcessedEventStore's own frozen shape. */
@Injectable()
export class PrismaProcessedEventStore implements ProcessedEventStore {
  constructor(private readonly prisma: PrismaService) {}

  find(eventId: string, consumerName: string): Promise<{ id: string } | null> {
    return this.prisma.processedEvent.findUnique({ where: { eventId_consumerName: { eventId, consumerName } }, select: { id: true } });
  }

  async create(eventId: string, consumerName: string): Promise<void> {
    await this.prisma.processedEvent.create({ data: { eventId, consumerName } });
  }
}
