/**
 * Decoupled from apps/api's generated Prisma Client type — same
 * reasoning as queue-name.ts's own QUEUE_NAMES duplication: this package
 * must stay usable from the worker process without depending on
 * apps/api's generated output. Structurally mirrors the `domain_events`
 * table exactly (apps/api/prisma/schema.prisma, Milestone 1F Engineering
 * Plan §11) — a real Prisma DomainEvent row already satisfies this shape
 * field-for-field.
 */
export interface DomainEventRecord {
  id: string;
  eventType: string;
  eventVersion: number;
  workspaceId: string | null;
  correlationId: string | null;
  causationId: string | null;
  payload: unknown;
  occurredAt: Date;
  dispatchedAt: Date | null;
}
