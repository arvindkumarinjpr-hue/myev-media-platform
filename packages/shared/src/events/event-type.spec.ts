import { isValidEventType, parseEventContractVersion } from "./event-type";

describe("EVENT_TYPE_PATTERN / isValidEventType", () => {
  it("accepts a well-formed {entity}.{action}.v{n} eventType", () => {
    expect(isValidEventType("content.published.v1")).toBe(true);
    expect(isValidEventType("system.probe-emitted.v12")).toBe(true);
  });

  it("rejects a jobType-shaped imperative name with no version suffix", () => {
    expect(isValidEventType("content.published")).toBe(false);
  });

  it("rejects uppercase, missing dot, or malformed version suffix", () => {
    expect(isValidEventType("Content.Published.v1")).toBe(false);
    expect(isValidEventType("content-published.v1")).toBe(false);
    expect(isValidEventType("content.published.1")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isValidEventType(undefined)).toBe(false);
    expect(isValidEventType(42)).toBe(false);
  });
});

describe("parseEventContractVersion", () => {
  it("extracts the integer version suffix", () => {
    expect(parseEventContractVersion("content.published.v1")).toBe(1);
    expect(parseEventContractVersion("content.published.v23")).toBe(23);
  });

  it("throws for a malformed eventType", () => {
    expect(() => parseEventContractVersion("content.published")).toThrow(/does not match/);
  });
});
