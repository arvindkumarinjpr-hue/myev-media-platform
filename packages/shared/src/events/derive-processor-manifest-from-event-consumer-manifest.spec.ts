import "reflect-metadata";
import { IsString } from "class-validator";
import { deriveProcessorManifestFromEventConsumerManifest } from "./derive-processor-manifest-from-event-consumer-manifest";
import { deriveEventConsumerJobType } from "./event-consumer-job-type";
import { EventConsumerJobEnvelopeDto } from "./event-consumer-job-envelope";
import { ProcessorManifestValidationError } from "../queue/processor-manifest";
import type { EventConsumerManifest } from "./event-consumer-manifest";

class BusinessPayload {
  @IsString()
  note!: string;
}

function validEventConsumerManifest(overrides: Partial<EventConsumerManifest> = {}): EventConsumerManifest {
  return {
    eventType: "content.published.v1",
    schemaVersion: 1,
    eventContractVersion: 1,
    consumerName: "content-projection",
    producer: "content",
    owningModule: "content",
    status: "active",
    queue: "PUBLISHING",
    payloadDto: BusinessPayload,
    idempotent: true,
    cancelable: false,
    supportsRetry: true,
    defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
    timeout: 10_000,
    maximumRuntime: 60_000,
    description: "Projects published content into the read model.",
    ...overrides,
  };
}

describe("deriveProcessorManifestFromEventConsumerManifest", () => {
  it("derives field-for-field parity for every shared field", () => {
    const input = validEventConsumerManifest();
    const derived = deriveProcessorManifestFromEventConsumerManifest(input);

    expect(derived.queue).toBe(input.queue);
    expect(derived.idempotent).toBe(input.idempotent);
    expect(derived.cancelable).toBe(input.cancelable);
    expect(derived.supportsRetry).toBe(input.supportsRetry);
    expect(derived.defaultRetryPolicy).toEqual(input.defaultRetryPolicy);
    expect(derived.timeout).toBe(input.timeout);
    expect(derived.maximumRuntime).toBe(input.maximumRuntime);
    expect(derived.owningModule).toBe(input.owningModule);
    expect(derived.version).toBe(input.eventContractVersion);
  });

  it("substitutes EventConsumerJobEnvelopeDto for payloadDto — never the business DTO", () => {
    const derived = deriveProcessorManifestFromEventConsumerManifest(validEventConsumerManifest());
    expect(derived.payloadDto).toBe(EventConsumerJobEnvelopeDto);
    expect(derived.payloadDto).not.toBe(BusinessPayload);
  });

  it("derives jobType using the single shared helper, not a re-implemented template", () => {
    const input = validEventConsumerManifest();
    const derived = deriveProcessorManifestFromEventConsumerManifest(input);
    expect(derived.jobType).toBe(deriveEventConsumerJobType(input.consumerName, input.eventContractVersion));
  });

  it("derives a distinct jobType/ProcessorManifest per eventContractVersion — v1 and v2 coexist", () => {
    const v1 = deriveProcessorManifestFromEventConsumerManifest(
      validEventConsumerManifest({ eventContractVersion: 1, eventType: "content.published.v1" }),
    );
    const v2 = deriveProcessorManifestFromEventConsumerManifest(
      validEventConsumerManifest({ eventContractVersion: 2, eventType: "content.published.v2" }),
    );

    expect(v1.jobType).toBe("event.content-projection.v1");
    expect(v2.jobType).toBe("event.content-projection.v2");
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
  });

  it("rejects a manifest that would derive an invalid ProcessorManifest, via the existing validator", () => {
    const invalid = validEventConsumerManifest({ owningModule: "" });
    expect(() => deriveProcessorManifestFromEventConsumerManifest(invalid)).toThrow(ProcessorManifestValidationError);
  });

  it("rejects a manifest whose consumerName cannot derive a valid jobType", () => {
    const invalid = validEventConsumerManifest({ consumerName: "Not Valid" });
    expect(() => deriveProcessorManifestFromEventConsumerManifest(invalid)).toThrow();
  });
});
