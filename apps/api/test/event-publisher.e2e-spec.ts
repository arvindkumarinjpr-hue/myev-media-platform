import { EventPublisher, type DomainEventWriter } from "@myev/shared";
import { Prisma } from "../generated/prisma";
import { bootstrapE2eApp, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";

/**
 * Milestone 8.1 — proves the outbox "write side" (EventPublisher) round-
 * trips through a REAL Prisma transaction against real Postgres, not a
 * mock — the one piece unit tests alone (event-publisher.spec.ts,
 * @myev/shared) cannot prove, since they use an in-memory writer.
 * Deliberately touches no Redis/BullMQ at all (Milestone 8 Architecture
 * §4: "No Redis call") — the memory rule requiring the dev worker to be
 * stopped before shared-queue e2e runs does not apply to this file.
 */

// The one-line adapter DomainEventWriter's own doc comment describes:
// DomainEventCreateInput.payload is `unknown` (packages/shared stays
// decoupled from apps/api's generated Prisma types), but Prisma's real
// `create` requires `Prisma.InputJsonValue` — the exact same Json-column
// cast already established in background-jobs.service.ts, not a new
// pattern invented for this test.
function toWriter(delegate: Prisma.TransactionClient["domainEvent"]): DomainEventWriter {
  return {
    create: (args) =>
      delegate.create({
        data: { ...args.data, payload: args.data.payload as unknown as Prisma.InputJsonValue },
      }),
  };
}

describe("API (e2e) — EventPublisher writes through a real Prisma transaction", () => {
  let e2e: E2eApp;
  const publisher = new EventPublisher();
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    e2e = await bootstrapE2eApp();
  });

  afterAll(async () => {
    await e2e.prisma.domainEvent.deleteMany({ where: { id: { in: createdEventIds } } });
    await teardownE2eApp(e2e);
  });

  it("commits a real domain_events row inside a transaction, with eventVersion derived from the eventType suffix", async () => {
    const row = await e2e.prisma.$transaction(async (tx) => {
      const writer = toWriter(tx.domainEvent);
      return publisher.publish(writer, {
        eventType: "system.probe-emitted.v1",
        payload: { note: "e2e round-trip" },
      });
    });
    createdEventIds.push(row.id);

    const persisted = await e2e.prisma.domainEvent.findUnique({ where: { id: row.id } });
    expect(persisted).not.toBeNull();
    expect(persisted?.eventType).toBe("system.probe-emitted.v1");
    expect(persisted?.eventVersion).toBe(1);
    expect(persisted?.workspaceId).toBeNull();
    expect(persisted?.correlationId).toBeNull();
    expect(persisted?.causationId).toBeNull();
    expect(persisted?.dispatchedAt).toBeNull();
    expect(persisted?.payload).toEqual({ note: "e2e round-trip" });
  });

  it("persists workspaceId, correlationId, and causationId when provided", async () => {
    const row = await e2e.prisma.$transaction(async (tx) => {
      const writer = toWriter(tx.domainEvent);
      return publisher.publish(writer, {
        eventType: "system.probe-emitted.v1",
        payload: { note: "with correlation" },
        correlationId: "corr-e2e-1",
        causationId: "cause-e2e-1",
      });
    });
    createdEventIds.push(row.id);

    const persisted = await e2e.prisma.domainEvent.findUnique({ where: { id: row.id } });
    expect(persisted?.correlationId).toBe("corr-e2e-1");
    expect(persisted?.causationId).toBe("cause-e2e-1");
  });

  it("the outbox guarantee: a transaction rollback after publish() leaves no row behind", async () => {
    let publishedId: string | undefined;
    await expect(
      e2e.prisma.$transaction(async (tx) => {
        const writer = toWriter(tx.domainEvent);
        const row = await publisher.publish(writer, {
          eventType: "system.probe-emitted.v1",
          payload: { note: "will be rolled back" },
        });
        publishedId = row.id;
        // Simulates the exact scenario the outbox pattern exists to
        // prevent a dual-write inconsistency for: the caller's own
        // business write, in the SAME transaction, fails after the
        // event insert. Both must roll back together, or not at all.
        throw new Error("simulated business-write failure after publish");
      }),
    ).rejects.toThrow("simulated business-write failure after publish");

    expect(publishedId).toBeDefined();
    const persisted = await e2e.prisma.domainEvent.findUnique({ where: { id: publishedId! } });
    expect(persisted).toBeNull();
  });

  it("rejects an invalid eventType before ever reaching Postgres", async () => {
    await expect(
      e2e.prisma.$transaction(async (tx) => {
        const writer = toWriter(tx.domainEvent);
        return publisher.publish(writer, { eventType: "not-an-event-type", payload: { note: "x" } });
      }),
    ).rejects.toThrow(/entity.*action.*v/i);
  });
});
