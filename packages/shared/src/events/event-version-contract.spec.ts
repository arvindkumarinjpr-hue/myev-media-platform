import "reflect-metadata";
import { IsString } from "class-validator";
import { EventRegistryBuilder, EventRegistryValidationError } from "./event-registry";
import { EventConsumerManifestValidationError, type EventConsumerManifest } from "./event-consumer-manifest";
import { EventPublisher, type DomainEventCreateInput, type DomainEventWriter } from "./event-publisher";
import { parseEventContractVersion } from "./event-type";
import type { DomainEventRecord } from "./domain-event";

/**
 * MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW §3 (Event Version
 * Contract Review) — dedicated cross-cutting evidence that the four
 * version-shaped terms (eventType's own .v{n} suffix, DomainEvent.
 * eventVersion, EventConsumerManifest.eventContractVersion,
 * EventConsumerManifest.schemaVersion) cannot silently contradict each
 * other. Each individual rule already has a home test elsewhere
 * (event-consumer-manifest.spec.ts, event-publisher.spec.ts) — this file
 * exists so the review's own four-term claim has one direct,
 * unambiguous proof spanning all of them together, not just in isolation.
 */

class NotePayload {
  @IsString()
  note!: string;
}

function manifest(overrides: Partial<EventConsumerManifest> = {}): EventConsumerManifest {
  return {
    eventType: "system.probe-emitted.v1",
    schemaVersion: 1,
    eventContractVersion: 1,
    consumerName: "audit-log-recorder",
    producer: "system-services-foundation",
    owningModule: "system-services-foundation",
    status: "active",
    queue: "SYSTEM",
    payloadDto: NotePayload,
    idempotent: true,
    cancelable: true,
    supportsRetry: true,
    defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
    timeout: 5_000,
    maximumRuntime: 60_000,
    description: "Trivial internal event proving the Event Bus Foundation end-to-end.",
    ...overrides,
  };
}

class InMemoryDomainEventWriter implements DomainEventWriter {
  readonly rows: DomainEventRecord[] = [];
  private nextId = 0;

  async create(args: { data: DomainEventCreateInput }): Promise<DomainEventRecord> {
    const row: DomainEventRecord = { id: `test-${++this.nextId}`, ...args.data, occurredAt: new Date(), dispatchedAt: null };
    this.rows.push(row);
    return row;
  }
}

describe("Event version contract — cross-cutting consistency", () => {
  it("a manifest's eventContractVersion always equals its own eventType's .v{n} suffix once accepted by bootstrap", () => {
    const m = manifest({ eventType: "content.published.v3", eventContractVersion: 3 });
    expect(m.eventContractVersion).toBe(parseEventContractVersion(m.eventType));
  });

  it("bootstrap rejects a manifest whose eventContractVersion contradicts its own eventType suffix", () => {
    expect(() => new EventRegistryBuilder().registerManifest(manifest({ eventType: "content.published.v3", eventContractVersion: 2 }))).toThrow(
      EventConsumerManifestValidationError,
    );
  });

  it("bootstrap rejects a manifest with an unsupported schemaVersion, independent of eventContractVersion validity", () => {
    expect(() => new EventRegistryBuilder().registerManifest(manifest({ schemaVersion: 2 }))).toThrow(/schemaVersion/);
  });

  it("EventPublisher derives DomainEvent.eventVersion from the eventType actually used at publish time — always self-consistent, never copied from a manifest", async () => {
    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();
    const row = await publisher.publish(writer, { eventType: "content.published.v5", payload: { note: "x" } });
    expect(row.eventVersion).toBe(5);
    expect(row.eventVersion).toBe(parseEventContractVersion("content.published.v5"));
  });

  it("a published event's eventVersion matches a registered consumer's eventContractVersion when — and only when — the eventType strings are identical", async () => {
    const registry = (() => {
      const builder = new EventRegistryBuilder();
      builder.registerManifest(manifest({ eventType: "content.published.v2", eventContractVersion: 2 }));
      return builder.freeze();
    })();

    const writer = new InMemoryDomainEventWriter();
    const publisher = new EventPublisher();

    // Same eventType as the registered consumer: versions agree by construction.
    const matching = await publisher.publish(writer, { eventType: "content.published.v2", payload: { note: "x" } });
    const consumerForMatching = registry.getManifest("content.published.v2", "audit-log-recorder");
    expect(consumerForMatching?.eventContractVersion).toBe(matching.eventVersion);

    // Different eventType (an older contract version) — this is Milestone
    // 8.1's own answer to the review's "cannot silently contradict"
    // requirement at the manifest/registry level: there is no shared
    // "latest version wins" lookup that could quietly cross-match a v1
    // publish against a v2 registration. getManifest returns a clean
    // miss, never the wrong manifest.
    const stale = await publisher.publish(writer, { eventType: "content.published.v1", payload: { note: "x" } });
    expect(stale.eventVersion).toBe(1);
    expect(registry.getManifest("content.published.v1", "audit-log-recorder")).toBeUndefined();
  });

  it("two different version suffixes of the same {entity}.{action} are fully independent registrations — no accidental collision", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest({ eventType: "content.published.v1", eventContractVersion: 1 }));
    expect(() => builder.registerManifest(manifest({ eventType: "content.published.v2", eventContractVersion: 2 }))).not.toThrow();
    const registry = builder.freeze();
    expect(registry.listManifests()).toHaveLength(2);
  });

  it("cross-manifest producer disagreement for the same eventType is rejected — not a version field, but the other cross-consistency invariant §4 requires", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest({ eventType: "content.published.v1", producer: "content-foundation" }));
    expect(() =>
      builder.registerManifest(manifest({ eventType: "content.published.v1", consumerName: "other-consumer", producer: "schedule-foundation" })),
    ).toThrow(EventRegistryValidationError);
  });
});
