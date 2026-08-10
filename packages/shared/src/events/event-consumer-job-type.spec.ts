import { deriveEventConsumerJobType } from "./event-consumer-job-type";

describe("deriveEventConsumerJobType", () => {
  it("derives the frozen event.{consumerName}.v{eventContractVersion} shape deterministically", () => {
    expect(deriveEventConsumerJobType("content-projection", 1)).toBe("event.content-projection.v1");
    expect(deriveEventConsumerJobType("content-projection", 1)).toBe(deriveEventConsumerJobType("content-projection", 1));
  });

  it("produces distinct jobTypes for distinct contract versions of the same consumer — no collision", () => {
    const v1 = deriveEventConsumerJobType("content-projection", 1);
    const v2 = deriveEventConsumerJobType("content-projection", 2);
    expect(v1).not.toBe(v2);
    expect(v1).toBe("event.content-projection.v1");
    expect(v2).toBe("event.content-projection.v2");
  });

  it("produces distinct jobTypes for distinct consumers of the same version", () => {
    expect(deriveEventConsumerJobType("content-projection", 1)).not.toBe(deriveEventConsumerJobType("media-projection", 1));
  });

  it("rejects a malformed consumerName", () => {
    expect(() => deriveEventConsumerJobType("Content_Projection", 1)).toThrow();
    expect(() => deriveEventConsumerJobType("content projection", 1)).toThrow();
    expect(() => deriveEventConsumerJobType("", 1)).toThrow();
  });

  it("rejects a non-positive-integer eventContractVersion", () => {
    expect(() => deriveEventConsumerJobType("content-projection", 0)).toThrow();
    expect(() => deriveEventConsumerJobType("content-projection", -1)).toThrow();
    expect(() => deriveEventConsumerJobType("content-projection", 1.5)).toThrow();
  });
});
