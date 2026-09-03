import { scoreCandidate, type CandidateScoringInput } from "./internal-link-scoring";

const NOW = new Date("2026-09-01T00:00:00Z");

const baseInput: CandidateScoringInput = {
  discoveryMethod: "token-fallback",
  sharedSeries: false,
  sharedSeriesHasTopicCluster: false,
  sharedKeywordClusterTerms: [],
  sourceKeywordClusterTermCount: 0,
  targetKeywordClusterTermCount: 0,
  sharedKpKeywords: [],
  sourceKpKeywordMentionCount: 0,
  sourceTokens: [],
  targetTokens: [],
  targetUpdatedAt: NOW,
  now: NOW,
  targetAuthorityScore: null,
  sourceRelativeLinkCount: 0,
};

describe("scoreCandidate", () => {
  it("is deterministic — identical input always produces an identical result", () => {
    const input: CandidateScoringInput = { ...baseInput, sharedSeries: true, sharedSeriesHasTopicCluster: true, sourceTokens: ["ev", "charging"], targetTokens: ["ev", "charging", "network"] };
    const a = scoreCandidate(input);
    const b = scoreCandidate(input);
    expect(a).toEqual(b);
  });

  it("returns 7 factors covering every implemented signal, weights summing to 12", () => {
    const result = scoreCandidate(baseInput);
    expect(result.factors.map((f) => f.id)).toEqual([
      "cluster-proximity",
      "keyword-cluster-overlap",
      "kp-keyword-coverage",
      "token-overlap",
      "target-freshness",
      "target-authority",
      "link-density-headroom",
    ]);
    expect(result.totalWeight).toBe(12);
  });

  it("every factor documents input/normalization/weight/contribution/reason", () => {
    const result = scoreCandidate(baseInput);
    for (const factor of result.factors) {
      expect(factor.rawValue).toBeDefined();
      expect(factor.normalizedScore).toBeGreaterThanOrEqual(0);
      expect(factor.normalizedScore).toBeLessThanOrEqual(100);
      expect(factor.weight).toBeGreaterThan(0);
      expect(factor.contribution).toBe(factor.normalizedScore * factor.weight);
      expect(typeof factor.reason).toBe("string");
      expect(factor.reason.length).toBeGreaterThan(0);
    }
  });

  it("clamps overallScore to 0-100 and it is always an integer", () => {
    const strong: CandidateScoringInput = {
      ...baseInput,
      sharedSeries: true,
      sharedSeriesHasTopicCluster: true,
      sharedKeywordClusterTerms: ["ev", "charging"],
      sourceKeywordClusterTermCount: 2,
      targetKeywordClusterTermCount: 2,
      sharedKpKeywords: ["ev charging"],
      sourceKpKeywordMentionCount: 1,
      sourceTokens: ["ev", "charging"],
      targetTokens: ["ev", "charging"],
      targetAuthorityScore: 100,
    };
    const result = scoreCandidate(strong);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
    expect(Number.isInteger(result.overallScore)).toBe(true);
  });

  it("cluster proximity: same series without a promoted cluster scores lower than with one", () => {
    const withCluster = scoreCandidate({ ...baseInput, sharedSeries: true, sharedSeriesHasTopicCluster: true });
    const withoutCluster = scoreCandidate({ ...baseInput, sharedSeries: true, sharedSeriesHasTopicCluster: false });
    const neither = scoreCandidate({ ...baseInput, sharedSeries: false, sharedSeriesHasTopicCluster: false });
    const clusterFactor = (r: ReturnType<typeof scoreCandidate>) => r.factors.find((f) => f.id === "cluster-proximity")!.normalizedScore;
    expect(clusterFactor(withCluster)).toBeGreaterThan(clusterFactor(withoutCluster));
    expect(clusterFactor(withoutCluster)).toBeGreaterThan(clusterFactor(neither));
  });

  it("target authority: missing ContentScore applies the documented neutral default, not zero or a crash", () => {
    const result = scoreCandidate({ ...baseInput, targetAuthorityScore: null });
    const factor = result.factors.find((f) => f.id === "target-authority")!;
    expect(factor.normalizedScore).toBe(50);
    expect(factor.reason).toMatch(/neutral default/i);
  });

  it("target freshness: full score within 30 days, zero at/after 180 days, linear between", () => {
    const fresh = scoreCandidate({ ...baseInput, targetUpdatedAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000) });
    const stale = scoreCandidate({ ...baseInput, targetUpdatedAt: new Date(NOW.getTime() - 200 * 24 * 60 * 60 * 1000) });
    const mid = scoreCandidate({ ...baseInput, targetUpdatedAt: new Date(NOW.getTime() - 105 * 24 * 60 * 60 * 1000) });
    const freshnessOf = (r: ReturnType<typeof scoreCandidate>) => r.factors.find((f) => f.id === "target-freshness")!.normalizedScore;
    expect(freshnessOf(fresh)).toBe(100);
    expect(freshnessOf(stale)).toBe(0);
    expect(freshnessOf(mid)).toBeGreaterThan(0);
    expect(freshnessOf(mid)).toBeLessThan(100);
  });

  it("link-density headroom decreases as the source already has more relative links", () => {
    const none = scoreCandidate({ ...baseInput, sourceRelativeLinkCount: 0 });
    const some = scoreCandidate({ ...baseInput, sourceRelativeLinkCount: 4 });
    const many = scoreCandidate({ ...baseInput, sourceRelativeLinkCount: 8 });
    const headroomOf = (r: ReturnType<typeof scoreCandidate>) => r.factors.find((f) => f.id === "link-density-headroom")!.normalizedScore;
    expect(headroomOf(none)).toBe(100);
    expect(headroomOf(many)).toBe(0);
    expect(headroomOf(some)).toBeGreaterThan(headroomOf(many));
    expect(headroomOf(some)).toBeLessThan(headroomOf(none));
  });

  it("keyword-cluster overlap and token overlap are 0 with no shared terms/tokens", () => {
    const result = scoreCandidate(baseInput);
    expect(result.factors.find((f) => f.id === "keyword-cluster-overlap")!.normalizedScore).toBe(0);
    expect(result.factors.find((f) => f.id === "token-overlap")!.normalizedScore).toBe(0);
    expect(result.factors.find((f) => f.id === "kp-keyword-coverage")!.normalizedScore).toBe(0);
  });

  it("discoveryMethod passes through unchanged", () => {
    for (const method of ["cluster", "keyword-cluster", "kp-keyword", "token-fallback"] as const) {
      expect(scoreCandidate({ ...baseInput, discoveryMethod: method }).discoveryMethod).toBe(method);
    }
  });
});
