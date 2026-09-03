import { buildCandidates, extractDomainToken, validateAnchorStructure } from "./internal-link-anchor";

describe("buildCandidates", () => {
  it("selects a natural phrase matching the target primary keyword, preserving source casing", () => {
    const source = "For a deep dive, see our guide to Home EV Charging setups and costs.";
    const candidates = buildCandidates(source, "The Complete Guide", "home ev charging");
    expect(candidates[0]).toEqual({ phrase: "Home EV Charging", source: "target-primary-keyword" });
  });

  it("falls back to a target-title subphrase when the primary keyword is not present in the source", () => {
    const source = "Read more about EV Battery Swap Stations near you.";
    const candidates = buildCandidates(source, "EV Battery Swap Stations Explained", "wireless charging");
    const titleMatch = candidates.find((c) => c.source === "target-title-subphrase");
    expect(titleMatch).toBeDefined();
    expect(titleMatch!.phrase.toLowerCase()).toContain("battery swap");
  });

  it("normalizes case-insensitively but returns the ORIGINAL source casing, never a synthesized string", () => {
    const source = "our COMPLETE guide to fast charging networks is here.";
    const candidates = buildCandidates(source, "Fast Charging Networks", null);
    const match = candidates.find((c) => c.source === "target-title-subphrase");
    expect(match!.phrase).toBe("fast charging networks"); // lowercase, exactly as it appears in the source
  });

  it("is tolerant of punctuation around the matched phrase", () => {
    const source = "Learn about home charging, costs, and installation.";
    const candidates = buildCandidates(source, "Home Charging Costs", null);
    expect(candidates.some((c) => c.source === "target-title-subphrase")).toBe(true);
  });

  it("always appends the target title as the final, unconditional fallback candidate", () => {
    const candidates = buildCandidates("completely unrelated text about bicycles", "Totally Different Subject", null);
    expect(candidates[candidates.length - 1]).toEqual({ phrase: "Totally Different Subject", source: "target-title-fallback" });
  });

  it("never invents a candidate that is not verbatim present in the source (except the final title fallback)", () => {
    const source = "bicycles are great for short trips around town.";
    const candidates = buildCandidates(source, "Electric Vehicle Charging Guide", "ev charging");
    const nonFallback = candidates.filter((c) => c.source !== "target-title-fallback");
    for (const c of nonFallback) {
      expect(source.toLowerCase()).toContain(c.phrase.toLowerCase());
    }
  });
});

describe("validateAnchorStructure", () => {
  it("accepts a normal 2-4 word phrase", () => {
    expect(validateAnchorStructure("home ev charging", [])).toEqual({ valid: true });
  });

  it("rejects fewer than 2 words", () => {
    expect(validateAnchorStructure("charging", []).valid).toBe(false);
  });

  it("rejects more than 8 words", () => {
    expect(validateAnchorStructure("this is a very long anchor phrase with way too many words", []).valid).toBe(false);
  });

  it("rejects phrases over 60 characters", () => {
    const long = "a".repeat(61);
    expect(validateAnchorStructure(`${long} bb`, []).valid).toBe(false);
  });

  it("rejects empty and whitespace-only candidates", () => {
    expect(validateAnchorStructure("", []).valid).toBe(false);
    expect(validateAnchorStructure("   ", []).valid).toBe(false);
  });

  it("rejects punctuation-only candidates", () => {
    expect(validateAnchorStructure("--- ...", []).valid).toBe(false);
  });

  it("rejects URL-like candidates", () => {
    expect(validateAnchorStructure("https://example.com/page", []).valid).toBe(false);
    expect(validateAnchorStructure("www.example.com", []).valid).toBe(false);
  });

  it("rejects sentence-like candidates (contains terminal punctuation)", () => {
    expect(validateAnchorStructure("charge your car today.", []).valid).toBe(false);
    expect(validateAnchorStructure("is this the best charger?", []).valid).toBe(false);
  });

  it("rejects keyword-stuffed candidates (same word repeated more than twice)", () => {
    expect(validateAnchorStructure("charging charging charging network", []).valid).toBe(false);
  });

  it("rejects a candidate containing a blocked (brand/competitor) term", () => {
    const result = validateAnchorStructure("voltiq home charger", ["voltiq"]);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("blocked-term");
  });

  it("does not over-block a generic word merely because it is a SUBSTRING of a blocked term", () => {
    // "volt" is a substring of "voltiq" but is not itself the blocked token — token match, not substring match.
    const result = validateAnchorStructure("volt meter reading guide", ["voltiq"]);
    expect(result.valid).toBe(true);
  });

  it("blocks only the exact blocked token, case-insensitively", () => {
    expect(validateAnchorStructure("chargepoint network review", ["chargepoint"]).valid).toBe(false);
    expect(validateAnchorStructure("CHARGEPOINT network review", ["chargepoint"]).valid).toBe(false);
  });
});

describe("extractDomainToken", () => {
  it("extracts the meaningful token from a plain domain", () => {
    expect(extractDomainToken("chargepoint.com")).toBe("chargepoint");
  });

  it("strips protocol and www", () => {
    expect(extractDomainToken("https://www.chargepoint.com/products")).toBe("chargepoint");
  });

  it("returns null for a token too short to be meaningful", () => {
    expect(extractDomainToken("a.co")).toBeNull();
  });
});
