import "reflect-metadata";
import { IsString } from "class-validator";
import { QueueRegistryBuilder, QueueRegistryValidationError, type ProcessorHandler } from "./queue-registry";
import type { ProcessorManifest } from "./processor-manifest";

class PingPayload {
  @IsString()
  message!: string;
}

function manifest(overrides: Partial<ProcessorManifest> = {}): ProcessorManifest {
  return {
    jobType: "system.ping.v1",
    schemaVersion: 1,
    version: 1,
    queue: "SYSTEM",
    payloadDto: PingPayload,
    idempotent: true,
    cancelable: true,
    supportsRetry: true,
    defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
    timeout: 5_000,
    maximumRuntime: 60_000,
    owningModule: "system-services-foundation",
    description: "Trivial internal job proving the pipeline end-to-end.",
    ...overrides,
  };
}

const noopHandler: ProcessorHandler = async () => undefined;

describe("QueueRegistryBuilder", () => {
  it("accumulates manifests and freezes into a queryable registry", () => {
    const builder = new QueueRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    expect(registry.getManifest("system.ping.v1")?.jobType).toBe("system.ping.v1");
    expect(registry.listManifests()).toHaveLength(1);
  });

  it("rejects a duplicate job type registration", () => {
    const builder = new QueueRegistryBuilder();
    builder.registerManifest(manifest());
    expect(() => builder.registerManifest(manifest())).toThrow(QueueRegistryValidationError);
  });

  it("rejects registration after freeze", () => {
    const builder = new QueueRegistryBuilder();
    builder.registerManifest(manifest());
    builder.freeze();
    expect(() => builder.registerManifest(manifest({ jobType: "system.echo.v1", version: 1 }))).toThrow(/already frozen/);
  });

  it("freezes each individual manifest — a mutation attempt throws, not silently succeeds", () => {
    const builder = new QueueRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    const stored = registry.getManifest("system.ping.v1")!;
    expect(() => {
      "use strict";
      // Object.freeze blocks this at runtime even though the type system
      // itself doesn't mark ProcessorManifest's fields readonly — the
      // guarantee is deliberately runtime, not compile-time, so it holds
      // even for code that only has a loosely-typed or `any` reference.
      stored.timeout = 999;
    }).toThrow(TypeError);
  });

  it("freezes the nested defaultRetryPolicy object too", () => {
    const builder = new QueueRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    const policy = registry.getManifest("system.ping.v1")!.defaultRetryPolicy!;
    expect(() => {
      "use strict";
      policy.maxAttempts = 99;
    }).toThrow(TypeError);
  });

  describe("bindHandler", () => {
    it("requires a manifest to already be registered", () => {
      const builder = new QueueRegistryBuilder();
      expect(() => builder.bindHandler("system.ping.v1", noopHandler)).toThrow(/no ProcessorManifest registered/);
    });

    it("rejects a duplicate handler binding for the same job type", () => {
      const builder = new QueueRegistryBuilder();
      builder.registerManifest(manifest());
      builder.bindHandler("system.ping.v1", noopHandler);
      expect(() => builder.bindHandler("system.ping.v1", noopHandler)).toThrow(/duplicate handler/);
    });

    it("rejects binding after freeze", () => {
      const builder = new QueueRegistryBuilder();
      builder.registerManifest(manifest());
      builder.freeze();
      expect(() => builder.bindHandler("system.ping.v1", noopHandler)).toThrow(/already frozen/);
    });
  });

  describe("bijective validation (Worker-scoped, requireHandlersForQueues)", () => {
    it("fails startup when an in-scope manifest has no bound handler", () => {
      const builder = new QueueRegistryBuilder();
      builder.registerManifest(manifest());
      expect(() => builder.freeze({ requireHandlersForQueues: ["SYSTEM"] })).toThrow(/no bound handler/);
    });

    it("succeeds when the in-scope manifest has exactly one bound handler", () => {
      const builder = new QueueRegistryBuilder();
      builder.registerManifest(manifest());
      builder.bindHandler("system.ping.v1", noopHandler);
      expect(() => builder.freeze({ requireHandlersForQueues: ["SYSTEM"] })).not.toThrow();
    });

    it("does not require a handler for a manifest outside the worker's queue scope", () => {
      const builder = new QueueRegistryBuilder();
      builder.registerManifest(manifest({ jobType: "media.transcode.v1", version: 1, queue: "MEDIA" }));
      // This worker only opens SYSTEM — the MEDIA-queue manifest is out of
      // scope and must not force a handler requirement.
      expect(() => builder.freeze({ requireHandlersForQueues: ["SYSTEM"] })).not.toThrow();
    });

    it("the API process (no requireHandlersForQueues) legitimately holds handler-less manifests", () => {
      const builder = new QueueRegistryBuilder();
      builder.registerManifest(manifest());
      expect(() => builder.freeze()).not.toThrow();
    });
  });

  it("QueueRegistry exposes no mutator — the collection's own immutability is structural, not a thrown error", () => {
    const builder = new QueueRegistryBuilder();
    builder.registerManifest(manifest());
    const registry = builder.freeze();
    // TypeScript itself proves this: there is no .register()/.bindHandler()
    // method on QueueRegistry's public type. This test documents that
    // guarantee — Object.keys should never include a mutator method name.
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(registry))).not.toEqual(expect.arrayContaining(["registerManifest", "bindHandler", "freeze"]));
  });
});
