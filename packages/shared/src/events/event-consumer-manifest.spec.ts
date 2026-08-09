import "reflect-metadata";
import { IsString } from "class-validator";
import { validateEventConsumerManifest, EventConsumerManifestValidationError, type EventConsumerManifest } from "./event-consumer-manifest";

class DecoratedPayload {
  @IsString()
  note!: string;
}

class UndecoratedPayload {
  note!: string;
}

function validManifest(overrides: Partial<EventConsumerManifest> = {}): EventConsumerManifest {
  return {
    eventType: "system.probe-emitted.v1",
    schemaVersion: 1,
    eventContractVersion: 1,
    consumerName: "audit-log-recorder",
    producer: "system-services-foundation",
    owningModule: "system-services-foundation",
    status: "active",
    queue: "SYSTEM",
    payloadDto: DecoratedPayload,
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

describe("validateEventConsumerManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(() => validateEventConsumerManifest(validManifest())).not.toThrow();
  });

  it("rejects a missing eventType", () => {
    expect(() => validateEventConsumerManifest(validManifest({ eventType: "" }))).toThrow(EventConsumerManifestValidationError);
  });

  it("rejects an eventType that doesn't match {entity}.{action}.v{n}", () => {
    expect(() => validateEventConsumerManifest(validManifest({ eventType: "content.published" }))).toThrow(/entity.*action.*v/i);
    expect(() => validateEventConsumerManifest(validManifest({ eventType: "Content.Published.v1" }))).toThrow();
  });

  it("rejects an eventContractVersion that doesn't match the eventType's .v{n} suffix", () => {
    expect(() => validateEventConsumerManifest(validManifest({ eventType: "system.probe-emitted.v2", eventContractVersion: 1 }))).toThrow(
      /does not match/i,
    );
  });

  it("rejects a non-integer or sub-1 schemaVersion", () => {
    expect(() => validateEventConsumerManifest(validManifest({ schemaVersion: 0 }))).toThrow(/schemaVersion/);
    expect(() => validateEventConsumerManifest(validManifest({ schemaVersion: 1.5 }))).toThrow(/schemaVersion/);
  });

  it("rejects an unrecognized schemaVersion", () => {
    expect(() => validateEventConsumerManifest(validManifest({ schemaVersion: 99 }))).toThrow(/not recognized/);
  });

  it("rejects a missing consumerName", () => {
    expect(() => validateEventConsumerManifest(validManifest({ consumerName: "  " }))).toThrow(/consumerName/);
  });

  it("rejects a missing producer", () => {
    expect(() => validateEventConsumerManifest(validManifest({ producer: "" }))).toThrow(/producer/);
  });

  it("rejects an invalid status", () => {
    // @ts-expect-error deliberately invalid at the type level too
    expect(() => validateEventConsumerManifest(validManifest({ status: "archived" }))).toThrow(/status must be one of/);
  });

  it("accepts status=deprecated", () => {
    expect(() => validateEventConsumerManifest(validManifest({ status: "deprecated" }))).not.toThrow();
  });

  it("rejects a queue outside the 9 recognized categories", () => {
    // @ts-expect-error deliberately invalid at the type level too
    expect(() => validateEventConsumerManifest(validManifest({ queue: "NOT_A_QUEUE" }))).toThrow(/queue/i);
  });

  it("rejects a missing payloadDto", () => {
    expect(() => validateEventConsumerManifest(validManifest({ payloadDto: undefined }))).toThrow(/payloadDto/);
  });

  it("rejects a payloadDto with no class-validator decorators — refuses an unvalidated placeholder class", () => {
    expect(() => validateEventConsumerManifest(validManifest({ payloadDto: UndecoratedPayload }))).toThrow(/no class-validator decorators/);
  });

  it("rejects non-positive timeout or maximumRuntime", () => {
    expect(() => validateEventConsumerManifest(validManifest({ timeout: 0 }))).toThrow(/timeout/);
    expect(() => validateEventConsumerManifest(validManifest({ maximumRuntime: -1 }))).toThrow(/maximumRuntime/);
  });

  it("rejects timeout exceeding maximumRuntime", () => {
    expect(() => validateEventConsumerManifest(validManifest({ timeout: 100_000, maximumRuntime: 50_000 }))).toThrow(/timeout must not exceed/);
  });

  it("rejects an invalid defaultRetryPolicy", () => {
    expect(() => validateEventConsumerManifest(validManifest({ defaultRetryPolicy: { maxAttempts: 0, backoffBaseMs: 1000 } }))).toThrow(
      /maxAttempts/,
    );
    expect(() => validateEventConsumerManifest(validManifest({ defaultRetryPolicy: { maxAttempts: 1, backoffBaseMs: 0 } }))).toThrow(
      /backoffBaseMs/,
    );
  });

  it("rejects supportsRetry=false combined with a multi-attempt defaultRetryPolicy — the cross-field consistency check", () => {
    expect(() =>
      validateEventConsumerManifest(validManifest({ supportsRetry: false, defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 } })),
    ).toThrow(/supportsRetry is false/);
  });

  it("accepts supportsRetry=false with a single-attempt (or absent) defaultRetryPolicy", () => {
    expect(() =>
      validateEventConsumerManifest(validManifest({ supportsRetry: false, defaultRetryPolicy: { maxAttempts: 1, backoffBaseMs: 30_000 } })),
    ).not.toThrow();
    expect(() => validateEventConsumerManifest(validManifest({ supportsRetry: false, defaultRetryPolicy: undefined }))).not.toThrow();
  });

  it("rejects missing owningModule or description", () => {
    expect(() => validateEventConsumerManifest(validManifest({ owningModule: "  " }))).toThrow(/owningModule/);
    expect(() => validateEventConsumerManifest(validManifest({ description: "" }))).toThrow(/description/);
  });
});
