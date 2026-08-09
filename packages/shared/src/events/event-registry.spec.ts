import "reflect-metadata";
import { IsString } from "class-validator";
import { EventRegistryBuilder, EventRegistryValidationError } from "./event-registry";
import type { EventConsumerManifest } from "./event-consumer-manifest";

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

describe("EventRegistryBuilder", () => {
  it("accumulates manifests and freezes into a queryable registry", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    expect(registry.getManifest("system.probe-emitted.v1", "audit-log-recorder")?.consumerName).toBe("audit-log-recorder");
    expect(registry.listManifests()).toHaveLength(1);
  });

  it("allows multiple consumers to register for the same eventType — fan-out, not a duplicate", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest({ consumerName: "audit-log-recorder" }));
    builder.registerManifest(manifest({ consumerName: "search-indexer" }));
    const registry = builder.freeze();
    expect(registry.getConsumersForEventType("system.probe-emitted.v1")).toHaveLength(2);
    expect(registry.listManifests()).toHaveLength(2);
  });

  it("rejects a duplicate (eventType, consumerName) registration", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    expect(() => builder.registerManifest(manifest())).toThrow(EventRegistryValidationError);
    expect(() => builder.registerManifest(manifest())).toThrow(/duplicate consumer registration/);
  });

  describe("producer consistency across consumers of the same eventType", () => {
    it("allows a second consumer that agrees on the same producer", () => {
      const builder = new EventRegistryBuilder();
      builder.registerManifest(manifest({ consumerName: "audit-log-recorder", producer: "system-services-foundation" }));
      expect(() =>
        builder.registerManifest(manifest({ consumerName: "search-indexer", producer: "system-services-foundation" })),
      ).not.toThrow();
    });

    it("rejects a second consumer that disagrees on the producer for the same eventType", () => {
      const builder = new EventRegistryBuilder();
      builder.registerManifest(manifest({ consumerName: "audit-log-recorder", producer: "system-services-foundation" }));
      expect(() => builder.registerManifest(manifest({ consumerName: "search-indexer", producer: "content-foundation" }))).toThrow(
        EventRegistryValidationError,
      );
      expect(() => builder.registerManifest(manifest({ consumerName: "search-indexer", producer: "content-foundation" }))).toThrow(
        /different producer/,
      );
    });

    it("does not compare producer across different eventTypes", () => {
      const builder = new EventRegistryBuilder();
      builder.registerManifest(manifest({ eventType: "system.probe-emitted.v1", producer: "system-services-foundation" }));
      expect(() =>
        builder.registerManifest(manifest({ eventType: "content.published.v1", consumerName: "audit-log-recorder", producer: "content-foundation" })),
      ).not.toThrow();
    });
  });

  it("rejects registration after freeze", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    builder.freeze();
    expect(() => builder.registerManifest(manifest({ consumerName: "search-indexer" }))).toThrow(/already frozen/);
  });

  it("rejects freezing twice", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    builder.freeze();
    expect(() => builder.freeze()).toThrow(/already frozen/);
  });

  it("propagates manifest validation errors from registerManifest", () => {
    const builder = new EventRegistryBuilder();
    expect(() => builder.registerManifest(manifest({ eventType: "not-an-event-type" }))).toThrow(/entity.*action.*v/i);
  });

  it("freezes each individual manifest — a mutation attempt throws, not silently succeeds", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    const stored = registry.getManifest("system.probe-emitted.v1", "audit-log-recorder")!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(() => {
      "use strict";
      stored.timeout = 999;
    }).toThrow(TypeError);
  });

  it("freezes the nested defaultRetryPolicy object too — deep, not shallow, immutability", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    const policy = registry.getManifest("system.probe-emitted.v1", "audit-log-recorder")!.defaultRetryPolicy!;
    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      "use strict";
      policy.maxAttempts = 99;
    }).toThrow(TypeError);
  });

  it("MILESTONE 8.1 §2: an empty registry (no consumers registered anywhere) freezes successfully — a valid state, not an error", () => {
    const builder = new EventRegistryBuilder();
    const registry = builder.freeze();
    expect(registry.listManifests()).toHaveLength(0);
    expect(registry.getConsumersForEventType("anything.at-all.v1")).toHaveLength(0);
  });

  it("returns undefined for an unregistered (eventType, consumerName) pair", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    expect(registry.getManifest("system.probe-emitted.v1", "unknown-consumer")).toBeUndefined();
    expect(registry.getManifest("unknown.event.v1", "audit-log-recorder")).toBeUndefined();
  });

  it("EventRegistry exposes no mutator — the collection's own immutability is structural", () => {
    const builder = new EventRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(registry))).not.toEqual(expect.arrayContaining(["registerManifest", "freeze"]));
  });
});
