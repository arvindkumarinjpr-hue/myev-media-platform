import type { DomainEventRecord } from "./domain-event";
import type { ProcessorContext } from "../queue/queue-registry";

/**
 * Milestone 8.3 FINAL CONTRACT CORRECTION §9 — the shared outcome shape
 * for both consumer categories. A discriminated union, never a bare
 * boolean, so a caller can never confuse "executed" with
 * "already processed" by accident.
 */
export type EventConsumerExecutionOutcome<TResult> = { outcome: "EXECUTED"; result: TResult } | { outcome: "ALREADY_PROCESSED" };

// ============================================================
// Category A — Postgres-only, transaction-bound consumers
// (Milestone 8.3 FINAL ARCHITECTURE FREEZE §5, FINAL CONTRACT
// CORRECTION §7)
// ============================================================

/**
 * Structural only — packages/shared never imports Prisma. `TTx` is
 * whatever transaction-client type the consuming process's own adapter
 * binds (apps/worker: Prisma.TransactionClient).
 */
export interface TransactionRunner<TTx> {
  run<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
}

export interface ProcessedEventReaderWriter<TTx> {
  find(tx: TTx, eventId: string, consumerName: string): Promise<{ id: string } | null>;
  create(tx: TTx, eventId: string, consumerName: string): Promise<void>;
}

/**
 * Transaction-scoped ownership for (domainEventId, consumerName) —
 * concretely a Postgres advisory lock (pg_advisory_xact_lock) in the
 * apps/worker adapter, auto-released at commit/rollback. packages/shared
 * knows nothing about that mechanism, only that acquisition happens
 * inside the same `tx` used for everything else in this execution.
 */
export interface AdvisoryLockAcquirer<TTx> {
  acquire(tx: TTx, domainEventId: string, consumerName: string): Promise<void>;
}

export type CategoryAExecute<TTx, TResult> = (tx: TTx, domainEvent: DomainEventRecord, context: ProcessorContext) => Promise<TResult>;

export interface CategoryAConsumerDeps<TTx> {
  transactionRunner: TransactionRunner<TTx>;
  advisoryLockAcquirer: AdvisoryLockAcquirer<TTx>;
  processedEventReaderWriter: ProcessedEventReaderWriter<TTx>;
}

/**
 * Milestone 8.3 FINAL CONTRACT CORRECTION §6. Structurally guarantees:
 * one transaction for the whole execution (a single `transactionRunner.
 * run()` call); the lock is acquired before the ProcessedEvent lookup;
 * the exact same `tx` reaches the lock, the lookup, the business
 * `execute` callback, and the ProcessedEvent insert; the business
 * callback never runs once `find` has already reported a match; and
 * nothing here interprets a Prisma error code or unique-constraint
 * violation — any duplicate-recovery interpretation of a thrown error
 * belongs to the concrete adapter (apps/worker, Phase 4), never to this
 * framework-independent wrapper. A thrown error from either the
 * business callback or the ProcessedEvent write simply propagates,
 * rolling back everything in the same transaction (both the business
 * effect and the completion marker) — no error is swallowed here.
 */
export async function wrapTransactionalConsumer<TTx, TResult>(
  deps: CategoryAConsumerDeps<TTx>,
  domainEvent: DomainEventRecord,
  consumerName: string,
  context: ProcessorContext,
  execute: CategoryAExecute<TTx, TResult>,
): Promise<EventConsumerExecutionOutcome<TResult>> {
  return deps.transactionRunner.run(async (tx) => {
    await deps.advisoryLockAcquirer.acquire(tx, domainEvent.id, consumerName);

    const alreadyProcessed = await deps.processedEventReaderWriter.find(tx, domainEvent.id, consumerName);
    if (alreadyProcessed) {
      return { outcome: "ALREADY_PROCESSED" as const };
    }

    const result = await execute(tx, domainEvent, context);
    await deps.processedEventReaderWriter.create(tx, domainEvent.id, consumerName);

    return { outcome: "EXECUTED" as const, result };
  });
}

// ============================================================
// Category B — consumers with external side effects, no
// transaction (Milestone 8.3 FINAL ARCHITECTURE FREEZE §6, FINAL
// CONTRACT CORRECTION §6/§7)
// ============================================================

/**
 * Deliberately not generic over `TTx`, and takes no transaction
 * parameter at all — a Postgres transaction must never wrap non-Postgres
 * network I/O (the same rule OutboxRelayManager's own dispatch already
 * follows). No adapter may pass a null or fake transaction client to
 * satisfy this interface; there is no transaction parameter to fake.
 */
export interface ProcessedEventStore {
  find(eventId: string, consumerName: string): Promise<{ id: string } | null>;
  create(eventId: string, consumerName: string): Promise<void>;
}

export type CategoryBExecute<TResult> = (
  domainEvent: DomainEventRecord,
  context: ProcessorContext,
  externalIdempotencyKey: string,
) => Promise<TResult>;

export interface CategoryBConsumerDeps {
  processedEventStore: ProcessedEventStore;
}

/**
 * Milestone 8.3 FINAL ARCHITECTURE FREEZE §6 — the deterministic key an
 * external system must be given so its own effect can be made
 * idempotent. One helper, used by wrapExternalEffectConsumer only, so no
 * two consumers can independently invent a different key shape for the
 * same (domainEventId, consumerName) pair.
 */
export function deriveExternalIdempotencyKey(domainEventId: string, consumerName: string): string {
  return `${domainEventId}:${consumerName}`;
}

/**
 * Milestone 8.3 FINAL CONTRACT CORRECTION §7. Frozen sequence: check
 * ProcessedEvent (no lock — a race here is possible and accepted, since
 * the external effect itself must be idempotent); if already processed,
 * skip the external effect entirely; otherwise invoke it with the
 * deterministic idempotency key, then record ProcessedEvent. If the
 * downstream external system cannot honor that key, this consumer's own
 * delivery semantics are explicitly AT-LEAST-ONCE — this wrapper does
 * not, and cannot, upgrade that to exactly-once.
 */
export async function wrapExternalEffectConsumer<TResult>(
  deps: CategoryBConsumerDeps,
  domainEvent: DomainEventRecord,
  consumerName: string,
  context: ProcessorContext,
  execute: CategoryBExecute<TResult>,
): Promise<EventConsumerExecutionOutcome<TResult>> {
  const alreadyProcessed = await deps.processedEventStore.find(domainEvent.id, consumerName);
  if (alreadyProcessed) {
    return { outcome: "ALREADY_PROCESSED" as const };
  }

  const externalIdempotencyKey = deriveExternalIdempotencyKey(domainEvent.id, consumerName);
  const result = await execute(domainEvent, context, externalIdempotencyKey);
  await deps.processedEventStore.create(domainEvent.id, consumerName);

  return { outcome: "EXECUTED" as const, result };
}
