/**
 * Decoupled shape for the `processed_events` table, same reasoning as
 * DomainEventRecord. Consumer-side idempotency for at-least-once event
 * delivery (Milestone 1F Engineering Plan §11) — existence of a row is
 * itself the "already processed" signal; no status column is needed.
 */
export interface ProcessedEventRecord {
  id: string;
  eventId: string;
  consumerName: string;
  processedAt: Date;
}
