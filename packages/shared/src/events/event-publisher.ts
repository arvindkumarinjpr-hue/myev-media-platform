import { EVENT_TYPE_PATTERN, parseEventContractVersion } from "./event-type";
import type { DomainEventRecord } from "./domain-event";

export class EventPublisherValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventPublisherValidationError";
  }
}

export interface DomainEventCreateInput {
  eventType: string;
  eventVersion: number;
  workspaceId: string | null;
  correlationId: string | null;
  causationId: string | null;
  payload: unknown;
}

/**
 * Structural — deliberately not apps/api's generated Prisma delegate
 * type, mirroring queue-name.ts's own decoupling: this package must stay
 * usable from the worker process without depending on apps/api's
 * generated output. A caller wires a real `tx.domainEvent` against this
 * shape with one cast at the call site (`payload as unknown as
 * Prisma.InputJsonValue`) — the exact same pattern already established
 * in background-jobs.service.ts for the identical Json-column mismatch,
 * not a new convention. Verified end-to-end against a real Prisma
 * transaction by apps/api/test/event-publisher.e2e-spec.ts.
 */
export interface DomainEventWriter {
  create(args: { data: DomainEventCreateInput }): Promise<DomainEventRecord>;
}

export interface PublishEventInput<TPayload = unknown> {
  eventType: string;
  payload: TPayload;
  workspaceId?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
}

/**
 * The entire outbox "write side" (Milestone 8 Architecture §4/§22) — a
 * thin, validated insert and nothing else. No Redis call, no queue
 * lookup, no consumer awareness, no dispatch (Milestone 8.1 scope is
 * strictly the write side — relay/dispatch is Milestone 8.2+). The
 * DomainEvent row IS the durability guarantee: pass the caller's own
 * transaction's `tx.domainEvent` as the writer so the business write and
 * this insert commit atomically, in the SAME Postgres transaction —
 * there is no dual-write window here at all.
 *
 * eventVersion is deliberately derived from eventType's own .v{n}
 * suffix (Milestone 8 Architecture §22), not accepted as a second,
 * independently-settable parameter that could drift out of sync with
 * the eventType string itself.
 */
export class EventPublisher {
  async publish<TPayload extends object>(writer: DomainEventWriter, input: PublishEventInput<TPayload>): Promise<DomainEventRecord> {
    if (!EVENT_TYPE_PATTERN.test(input.eventType)) {
      throw new EventPublisherValidationError(`eventType "${input.eventType}" must match {entity}.{action}.v{n}`);
    }
    if (input.payload === null || typeof input.payload !== "object") {
      throw new EventPublisherValidationError("payload must be a non-null object");
    }

    const eventVersion = parseEventContractVersion(input.eventType);

    return writer.create({
      data: {
        eventType: input.eventType,
        eventVersion,
        workspaceId: input.workspaceId ?? null,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
        payload: input.payload,
      },
    });
  }
}
