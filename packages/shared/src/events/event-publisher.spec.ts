import { EventPublisher, EventPublisherValidationError, type DomainEventCreateInput, type DomainEventWriter } from "./event-publisher";
import type { DomainEventRecord } from "./domain-event";

// In-memory stand-in for a real Prisma tx.domainEvent delegate — proves
// EventPublisher's own logic (validation, eventVersion derivation,
// default handling) in complete isolation from any real database. The
// real-Postgres round-trip through an actual Prisma transaction is
// covered separately by apps/api/test/event-publisher.e2e-spec.ts. No
// Node builtins (e.g. crypto.randomUUID) — this package has no @types/node
// dependency, so a simple counter stands in for a real id generator here.
let nextId = 0;

class InMemoryDomainEventWriter implements DomainEventWriter {
  readonly rows: DomainEventRecord[] = [];

  async create(args: { data: DomainEventCreateInput }): Promise<DomainEventRecord> {
    const row: DomainEventRecord = {
      id: `test-${++nextId}`,
      ...args.data,
      occurredAt: new Date(),
      dispatchedAt: null,
    };
    this.rows.push(row);
    return row;
  }
}

describe("EventPublisher", () => {
  it("derives eventVersion from the eventType's own .v{n} suffix", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    const row = await publisher.publish(writer, { eventType: "system.probe-emitted.v3", payload: { note: "hi" } });
    expect(row.eventVersion).toBe(3);
  });

  it("writes exactly one row via the provided writer, nothing else", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    await publisher.publish(writer, { eventType: "system.probe-emitted.v1", payload: { note: "hi" } });
    expect(writer.rows).toHaveLength(1);
  });

  it("defaults workspaceId, correlationId, causationId to null when omitted", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    const row = await publisher.publish(writer, { eventType: "system.probe-emitted.v1", payload: { note: "hi" } });
    expect(row.workspaceId).toBeNull();
    expect(row.correlationId).toBeNull();
    expect(row.causationId).toBeNull();
  });

  it("passes through workspaceId, correlationId, causationId when provided", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    const row = await publisher.publish(writer, {
      eventType: "system.probe-emitted.v1",
      payload: { note: "hi" },
      workspaceId: "ws-1",
      correlationId: "corr-1",
      causationId: "cause-1",
    });
    expect(row.workspaceId).toBe("ws-1");
    expect(row.correlationId).toBe("corr-1");
    expect(row.causationId).toBe("cause-1");
  });

  it("rejects an eventType that doesn't match {entity}.{action}.v{n}", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    await expect(publisher.publish(writer, { eventType: "content.published", payload: { note: "hi" } })).rejects.toThrow(
      EventPublisherValidationError,
    );
    expect(writer.rows).toHaveLength(0);
  });

  it("rejects a null or non-object payload without writing a row", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    // @ts-expect-error deliberately invalid at the type level too
    await expect(publisher.publish(writer, { eventType: "system.probe-emitted.v1", payload: null })).rejects.toThrow(
      EventPublisherValidationError,
    );
    // @ts-expect-error deliberately invalid at the type level too
    await expect(publisher.publish(writer, { eventType: "system.probe-emitted.v1", payload: "not-an-object" })).rejects.toThrow(
      EventPublisherValidationError,
    );
    expect(writer.rows).toHaveLength(0);
  });

  it("propagates a writer failure without swallowing it", async () => {
    const failingWriter: DomainEventWriter = {
      create: async () => {
        throw new Error("connection reset");
      },
    };
    const publisher = new EventPublisher();
    await expect(publisher.publish(failingWriter, { eventType: "system.probe-emitted.v1", payload: { note: "hi" } })).rejects.toThrow(
      "connection reset",
    );
  });
});
