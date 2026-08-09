import "reflect-metadata";
import { IsString } from "class-validator";
import { validateProcessorManifest, ProcessorManifestValidationError, type ProcessorManifest } from "./processor-manifest";

class DecoratedPayload {
  @IsString()
  message!: string;
}

class UndecoratedPayload {
  message!: string;
}

function validManifest(overrides: Partial<ProcessorManifest> = {}): ProcessorManifest {
  return {
    jobType: "system.ping.v1",
    schemaVersion: 1,
    version: 1,
    queue: "SYSTEM",
    payloadDto: DecoratedPayload,
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

describe("validateProcessorManifest", () => {
  it("accepts a well-formed manifest", () => {
    expect(() => validateProcessorManifest(validManifest())).not.toThrow();
  });

  it("rejects a missing jobType", () => {
    expect(() => validateProcessorManifest(validManifest({ jobType: "" }))).toThrow(ProcessorManifestValidationError);
  });

  it("rejects a jobType that doesn't match {domain}.{action}.v{n}", () => {
    expect(() => validateProcessorManifest(validManifest({ jobType: "system.ping" }))).toThrow(/domain.*action.*v/i);
    expect(() => validateProcessorManifest(validManifest({ jobType: "SystemPing.v1" }))).toThrow();
  });

  it("rejects a version that doesn't match the jobType's .v{n} suffix", () => {
    expect(() => validateProcessorManifest(validManifest({ jobType: "system.ping.v2", version: 1 }))).toThrow(/does not match/i);
  });

  it("rejects a non-integer or sub-1 schemaVersion", () => {
    expect(() => validateProcessorManifest(validManifest({ schemaVersion: 0 }))).toThrow(/schemaVersion/);
    expect(() => validateProcessorManifest(validManifest({ schemaVersion: 1.5 }))).toThrow(/schemaVersion/);
  });

  it("rejects an unrecognized schemaVersion", () => {
    expect(() => validateProcessorManifest(validManifest({ schemaVersion: 99 }))).toThrow(/not recognized/);
  });

  it("rejects a queue outside the 9 recognized categories", () => {
    // @ts-expect-error deliberately invalid at the type level too
    expect(() => validateProcessorManifest(validManifest({ queue: "NOT_A_QUEUE" }))).toThrow(/queue/i);
  });

  it("rejects a missing payloadDto", () => {
    expect(() => validateProcessorManifest(validManifest({ payloadDto: undefined }))).toThrow(/payloadDto/);
  });

  it("rejects a payloadDto with no class-validator decorators — refuses an unvalidated placeholder class", () => {
    expect(() => validateProcessorManifest(validManifest({ payloadDto: UndecoratedPayload }))).toThrow(/no class-validator decorators/);
  });

  it("accepts a decorated resultDto and rejects an undecorated one", () => {
    expect(() => validateProcessorManifest(validManifest({ resultDto: DecoratedPayload }))).not.toThrow();
    expect(() => validateProcessorManifest(validManifest({ resultDto: UndecoratedPayload }))).toThrow(/no class-validator decorators/);
  });

  it("rejects non-positive timeout or maximumRuntime", () => {
    expect(() => validateProcessorManifest(validManifest({ timeout: 0 }))).toThrow(/timeout/);
    expect(() => validateProcessorManifest(validManifest({ maximumRuntime: -1 }))).toThrow(/maximumRuntime/);
  });

  it("rejects timeout exceeding maximumRuntime", () => {
    expect(() => validateProcessorManifest(validManifest({ timeout: 100_000, maximumRuntime: 50_000 }))).toThrow(/timeout must not exceed/);
  });

  it("rejects an invalid defaultRetryPolicy", () => {
    expect(() => validateProcessorManifest(validManifest({ defaultRetryPolicy: { maxAttempts: 0, backoffBaseMs: 1000 } }))).toThrow(/maxAttempts/);
    expect(() => validateProcessorManifest(validManifest({ defaultRetryPolicy: { maxAttempts: 1, backoffBaseMs: 0 } }))).toThrow(/backoffBaseMs/);
  });

  it("rejects supportsRetry=false combined with a multi-attempt defaultRetryPolicy — the cross-field consistency check", () => {
    expect(() =>
      validateProcessorManifest(validManifest({ supportsRetry: false, defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 } })),
    ).toThrow(/supportsRetry is false/);
  });

  it("accepts supportsRetry=false with a single-attempt (or absent) defaultRetryPolicy", () => {
    expect(() =>
      validateProcessorManifest(validManifest({ supportsRetry: false, defaultRetryPolicy: { maxAttempts: 1, backoffBaseMs: 30_000 } })),
    ).not.toThrow();
    expect(() => validateProcessorManifest(validManifest({ supportsRetry: false, defaultRetryPolicy: undefined }))).not.toThrow();
  });

  it("rejects missing owningModule or description", () => {
    expect(() => validateProcessorManifest(validManifest({ owningModule: "  " }))).toThrow(/owningModule/);
    expect(() => validateProcessorManifest(validManifest({ description: "" }))).toThrow(/description/);
  });
});
