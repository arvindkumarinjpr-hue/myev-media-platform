import { normalizeExpectedChecksum, truncateChecksumForLogging } from "./checksum.util";

const VALID_LOWER = "a".repeat(64);
const VALID_UPPER = "A".repeat(64);
const VALID_MIXED = "aAbBcCdDeEfF0011223344556677889900112233445566778899aabbccdd".padEnd(64, "0");

describe("normalizeExpectedChecksum", () => {
  it("accepts a valid lowercase 64-char hex string unchanged", () => {
    expect(normalizeExpectedChecksum(VALID_LOWER)).toBe(VALID_LOWER);
  });

  it("normalizes uppercase to lowercase rather than rejecting it", () => {
    expect(normalizeExpectedChecksum(VALID_UPPER)).toBe(VALID_LOWER);
  });

  it("normalizes mixed-case input", () => {
    expect(normalizeExpectedChecksum(VALID_MIXED)).toBe(VALID_MIXED.toLowerCase());
  });

  it("rejects a string that's too short", () => {
    expect(normalizeExpectedChecksum("a".repeat(63))).toBeNull();
  });

  it("rejects a string that's too long", () => {
    expect(normalizeExpectedChecksum("a".repeat(65))).toBeNull();
  });

  it("rejects non-hex characters", () => {
    expect(normalizeExpectedChecksum("g".repeat(64))).toBeNull();
    expect(normalizeExpectedChecksum("a".repeat(63) + "!")).toBeNull();
  });
});

describe("truncateChecksumForLogging", () => {
  it("never includes the full checksum", () => {
    const truncated = truncateChecksumForLogging(VALID_LOWER);
    expect(truncated).not.toBe(VALID_LOWER);
    expect(truncated.length).toBeLessThan(VALID_LOWER.length);
    expect(truncated.startsWith(VALID_LOWER.slice(0, 8))).toBe(true);
  });
});
