import { ContentScoringEngine, ContentScoringEngineError } from "./content-scoring-engine";
import type { ContentDimension, DimensionEvaluation } from "./content-dimension";
import { SCORE_CATEGORIES } from "./score-category";
import { ScoreOutOfRangeError } from "./score-bounds";
import type { ScoringFactor } from "./scoring-factor";
import type { ScoringInput } from "./scoring-input";
import { makeSyntheticDimension } from "./testing/synthetic-dimension";

const INPUT: ScoringInput = { contentType: "PODCAST", title: "A podcast episode about EV charging at home", bodyText: "x".repeat(60), knowledgePackActive: true };

function dimensionReturning(evaluation: DimensionEvaluation): ContentDimension {
  return { name: "stub", version: 1, appliesTo: ["PODCAST"], dimensionScoreLabel: "Stub Score", purpose: "test", evaluate: () => evaluation };
}

describe("ContentScoringEngine", () => {
  const engine = new ContentScoringEngine();

  it("produces an overall = mean of the five aggregated category scores, plus a separate dimension score", () => {
    const result = engine.score(INPUT, makeSyntheticDimension());
    expect(SCORE_CATEGORIES.every((c) => result.categoryScores[c] >= 0 && result.categoryScores[c] <= 100)).toBe(true);
    const mean = Math.round(SCORE_CATEGORIES.reduce((s, c) => s + result.categoryScores[c], 0) / 5);
    expect(result.overallScore).toBe(mean);
    expect(result.dimension.name).toBe("synthetic");
    expect(result.dimension.score).toBeGreaterThanOrEqual(0);
    expect(result.dimension.score).toBeLessThanOrEqual(100);
  });

  it("is deterministic — same input+dimension yields a structurally identical result", () => {
    const a = engine.score(INPUT, makeSyntheticDimension());
    const b = engine.score(INPUT, makeSyntheticDimension());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("aggregates a category as the weighted mean of its factors", () => {
    const categoryFactors: ScoringFactor[] = SCORE_CATEGORIES.flatMap((category): ScoringFactor[] =>
      category === "SEO"
        ? [
            { id: "seo-a", category, label: "a", value: 100, weight: 3, reason: "r" },
            { id: "seo-b", category, label: "b", value: 20, weight: 1, reason: "r" },
          ]
        : [{ id: `${category.toLowerCase()}-x`, category, label: "x", value: 50, weight: 1, reason: "r" }],
    );
    const dim = dimensionReturning({ categoryFactors, dimensionScore: 50, dimensionFactors: [], recommendations: [] });
    const result = engine.score(INPUT, dim);
    // (100*3 + 20*1) / 4 = 80
    expect(result.categoryScores.SEO).toBe(80);
    expect(result.categoryScores.VIRAL).toBe(50);
  });

  it("orders factors by category then id, and dimension factors last", () => {
    const result = engine.score(INPUT, makeSyntheticDimension());
    const cats = result.factors.map((f) => (f.category === null ? "ZZZ" : f.category));
    const sorted = [...cats].sort((a, b) => {
      const order = ["SEO", "VIRAL", "QUALITY", "ENGAGEMENT", "BUSINESS", "ZZZ"];
      return order.indexOf(a) - order.indexOf(b);
    });
    expect(cats).toEqual(sorted);
    expect(result.factors[result.factors.length - 1].category).toBeNull();
  });

  describe("contract enforcement on the dimension's output", () => {
    it("rejects a missing universal category", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.filter((c) => c !== "BUSINESS").map((category) => ({ id: category.toLowerCase(), category, label: "x", value: 50, weight: 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [],
        recommendations: [],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(/missing: BUSINESS/);
    });

    it("rejects an out-of-range factor value", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.map((category) => ({ id: category.toLowerCase(), category, label: "x", value: category === "SEO" ? 150 : 50, weight: 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [],
        recommendations: [],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(ScoreOutOfRangeError);
    });

    it("rejects duplicate factor ids", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.map((category) => ({ id: "same", category, label: "x", value: 50, weight: 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [],
        recommendations: [],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(/duplicate factor id/);
    });

    it("rejects a category factor with a null category", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.map((category, i) => ({ id: `f${i}`, category: i === 0 ? null : category, label: "x", value: 50, weight: 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [],
        recommendations: [],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(ContentScoringEngineError);
    });

    it("rejects a dimension factor that carries a category", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.map((category) => ({ id: category.toLowerCase(), category, label: "x", value: 50, weight: 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [{ id: "d1", category: "SEO", label: "x", value: 50, weight: 1, reason: "r" }],
        recommendations: [],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(/must have category: null/);
    });

    it("rejects a recommendation pointing at an unknown factor", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.map((category) => ({ id: category.toLowerCase(), category, label: "x", value: 50, weight: 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [],
        recommendations: [{ id: "r1", priority: "LOW", category: "SEO", message: "m", relatedFactorId: "nope" }],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(/unknown factor/);
    });

    it("rejects a non-positive factor weight", () => {
      const dim = dimensionReturning({
        categoryFactors: SCORE_CATEGORIES.map((category) => ({ id: category.toLowerCase(), category, label: "x", value: 50, weight: category === "SEO" ? 0 : 1, reason: "r" })),
        dimensionScore: 50,
        dimensionFactors: [],
        recommendations: [],
      });
      expect(() => engine.score(INPUT, dim)).toThrow(/weight > 0/);
    });
  });
});
