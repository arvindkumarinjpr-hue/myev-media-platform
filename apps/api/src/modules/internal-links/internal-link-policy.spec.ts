import { DEFAULT_INTERNAL_LINKING_POLICY, resolveInternalLinkingPolicy } from "./internal-link-policy";

describe("resolveInternalLinkingPolicy", () => {
  it("returns safe defaults for null/undefined/non-object input, never throws", () => {
    expect(resolveInternalLinkingPolicy(null)).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
    expect(resolveInternalLinkingPolicy(undefined)).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
    expect(resolveInternalLinkingPolicy("nonsense")).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
    expect(resolveInternalLinkingPolicy(42)).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
    expect(resolveInternalLinkingPolicy([])).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
  });

  it("returns defaults for the empty object (the column's own DB default)", () => {
    expect(resolveInternalLinkingPolicy({})).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
  });

  it("parses a fully-populated, well-formed policy", () => {
    const result = resolveInternalLinkingPolicy({
      maxLinksPerArticle: 12,
      maxExactMatchAnchorRepeats: 3,
      excludedContentItemIds: ["a", "b"],
      minRelevanceScore: 60,
    });
    expect(result).toEqual({ maxLinksPerArticle: 12, maxExactMatchAnchorRepeats: 3, excludedContentItemIds: ["a", "b"], minRelevanceScore: 60 });
  });

  it("falls back per-key on malformed/partial values — one bad key never invalidates the others", () => {
    const result = resolveInternalLinkingPolicy({
      maxLinksPerArticle: "not-a-number",
      maxExactMatchAnchorRepeats: -5,
      excludedContentItemIds: "not-an-array",
      minRelevanceScore: 999, // out of 0-100 range
    });
    expect(result).toEqual(DEFAULT_INTERNAL_LINKING_POLICY);
  });

  it("filters non-string entries out of excludedContentItemIds rather than rejecting the whole array", () => {
    const result = resolveInternalLinkingPolicy({ excludedContentItemIds: ["valid-id", 42, null, "", "  ", "another-valid-id"] });
    expect(result.excludedContentItemIds).toEqual(["valid-id", "another-valid-id"]);
  });

  it("accepts minRelevanceScore at the 0 and 100 boundaries", () => {
    expect(resolveInternalLinkingPolicy({ minRelevanceScore: 0 }).minRelevanceScore).toBe(0);
    expect(resolveInternalLinkingPolicy({ minRelevanceScore: 100 }).minRelevanceScore).toBe(100);
  });

  it("ignores unrecognized keys without error (future-compatible)", () => {
    const result = resolveInternalLinkingPolicy({ someFutureKey: "whatever", maxExactMatchAnchorRepeats: 5 });
    expect(result.maxExactMatchAnchorRepeats).toBe(5);
  });
});
