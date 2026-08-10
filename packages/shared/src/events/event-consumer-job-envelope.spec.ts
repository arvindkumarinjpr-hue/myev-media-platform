import "reflect-metadata";
import { validate } from "class-validator";
import { EventConsumerJobEnvelopeDto, type EventConsumerJobEnvelope } from "./event-consumer-job-envelope";

function validEnvelope(overrides: Partial<EventConsumerJobEnvelope> = {}): EventConsumerJobEnvelope {
  return {
    domainEventId: "1b1c1111-1111-4111-8111-111111111111",
    eventType: "content.published.v1",
    eventVersion: 1,
    consumerName: "content-projection",
    workspaceId: "2b2c2222-2222-4222-8222-222222222222",
    correlationId: "corr-1",
    causationId: "cause-1",
    ...overrides,
  };
}

function toDto(fields: EventConsumerJobEnvelope): EventConsumerJobEnvelopeDto {
  return Object.assign(new EventConsumerJobEnvelopeDto(), fields);
}

describe("EventConsumerJobEnvelopeDto", () => {
  it("accepts a well-formed envelope", async () => {
    const errors = await validate(toDto(validEnvelope()));
    expect(errors).toHaveLength(0);
  });

  it("accepts null workspaceId, correlationId, and causationId", async () => {
    const errors = await validate(toDto(validEnvelope({ workspaceId: null, correlationId: null, causationId: null })));
    expect(errors).toHaveLength(0);
  });

  it("rejects a malformed domainEventId", async () => {
    const errors = await validate(toDto(validEnvelope({ domainEventId: "not-a-uuid" })));
    expect(errors.some((e) => e.property === "domainEventId")).toBe(true);
  });

  it("rejects an eventType that doesn't match {entity}.{action}.v{n}", async () => {
    const errors = await validate(toDto(validEnvelope({ eventType: "content-published" })));
    expect(errors.some((e) => e.property === "eventType")).toBe(true);
  });

  it("rejects a non-integer or sub-1 eventVersion", async () => {
    expect((await validate(toDto(validEnvelope({ eventVersion: 0 })))).some((e) => e.property === "eventVersion")).toBe(true);
    expect((await validate(toDto(validEnvelope({ eventVersion: 1.5 })))).some((e) => e.property === "eventVersion")).toBe(true);
  });

  it("rejects a missing consumerName", async () => {
    const errors = await validate(toDto(validEnvelope({ consumerName: "" })));
    expect(errors.some((e) => e.property === "consumerName")).toBe(true);
  });

  it("rejects a malformed (non-UUID, non-null) workspaceId", async () => {
    const errors = await validate(toDto(validEnvelope({ workspaceId: "not-a-uuid" })));
    expect(errors.some((e) => e.property === "workspaceId")).toBe(true);
  });

  it("does not coerce null to undefined — a null field stays structurally distinct from an absent one", () => {
    const dto = toDto(validEnvelope({ correlationId: null }));
    expect("correlationId" in dto).toBe(true);
    expect(dto.correlationId).toBeNull();
    expect(dto.correlationId).not.toBeUndefined();
  });
});
