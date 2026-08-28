import { ContentScoringEngine } from "./content-scoring-engine";
import { SCORE_CATEGORIES } from "./score-category";
import type { ScoringInput } from "./scoring-input";
import { BLOG_DIMENSION_V1 } from "./dimensions/blog-dimension";

const engine = new ContentScoringEngine();

const STRONG_BLOG: ScoringInput = {
  contentType: "BLOG",
  title: "The Complete Guide to Home EV Charging: Costs, Setup, and Savings",
  bodyText: [
    "Charging an electric vehicle at home is the most convenient and cheapest way to keep your car ready. This guide walks through everything you need.",
    "A Level 2 charger adds about 25 miles of range per hour. Most owners install one in their garage. The best way to get started is to book a demo with a certified electrician.",
    "How much does it cost? A typical install runs a few hundred dollars. You can learn more from your utility's rebate page.",
    "Frequently asked questions help cover the details buyers care about most.",
  ].join("\n\n"),
  headings: [
    { level: 1, text: "The Complete Guide to Home EV Charging" },
    { level: 2, text: "Why charge at home" },
    { level: 2, text: "Choosing a Level 2 charger" },
    { level: 3, text: "Installation steps" },
    { level: 2, text: "Costs and savings" },
    { level: 2, text: "Frequently asked questions" },
  ],
  faqQuestions: ["How much does home charging cost?", "Do I need a permit?", "How long does installation take?"],
  internalLinkCount: 3,
  externalLinkCount: 2,
  mediaReferenceCount: 4,
  metadata: {
    metaTitle: "Home EV Charging Guide: Costs & Setup",
    metaDescription: "Everything you need to charge your EV at home: Level 2 chargers, installation costs, utility rebates, and how much you can save each month.",
    urlSlug: "home-ev-charging-guide",
    hasSchemaMarkup: true,
  },
  targetKeywords: ["home ev charging", "level 2 charger", "ev charging costs"],
  primaryKeyword: "home ev charging",
  brandTerms: ["EVolt"],
  knowledgePackActive: true,
};

const WEAK_BLOG: ScoringInput = {
  contentType: "BLOG",
  title: "charging",
  bodyText: "Cars need power sometimes and this is a short note about that topic without much detail at all here.",
  headings: [],
  knowledgePackActive: false,
};

describe("BLOG_DIMENSION_V1", () => {
  it("is deterministic — identical input yields byte-identical output", () => {
    expect(JSON.stringify(engine.score(STRONG_BLOG, BLOG_DIMENSION_V1))).toBe(JSON.stringify(engine.score(STRONG_BLOG, BLOG_DIMENSION_V1)));
  });

  it("covers all five universal categories with at least one factor each", () => {
    const evalResult = BLOG_DIMENSION_V1.evaluate(STRONG_BLOG);
    const covered = new Set(evalResult.categoryFactors.map((f) => f.category));
    for (const c of SCORE_CATEGORIES) expect(covered.has(c)).toBe(true);
    expect(evalResult.categoryFactors.every((f) => f.category !== null)).toBe(true);
    expect(evalResult.dimensionFactors.every((f) => f.category === null)).toBe(true);
  });

  it("keeps every score and factor value within [0, 100]", () => {
    for (const input of [STRONG_BLOG, WEAK_BLOG]) {
      const r = engine.score(input, BLOG_DIMENSION_V1);
      expect(r.overallScore).toBeGreaterThanOrEqual(0);
      expect(r.overallScore).toBeLessThanOrEqual(100);
      expect(r.dimension.score).toBeGreaterThanOrEqual(0);
      expect(r.dimension.score).toBeLessThanOrEqual(100);
      for (const c of SCORE_CATEGORIES) {
        expect(r.categoryScores[c]).toBeGreaterThanOrEqual(0);
        expect(r.categoryScores[c]).toBeLessThanOrEqual(100);
      }
      for (const f of r.factors) {
        expect(f.value).toBeGreaterThanOrEqual(0);
        expect(f.value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("scores a strong article meaningfully higher than a thin one", () => {
    const strong = engine.score(STRONG_BLOG, BLOG_DIMENSION_V1);
    const weak = engine.score(WEAK_BLOG, BLOG_DIMENSION_V1);
    expect(strong.overallScore).toBeGreaterThan(weak.overallScore + 20);
    expect(strong.dimension.score).toBeGreaterThan(weak.dimension.score);
  });

  it("emits actionable recommendations for the weak article, tied to real factors", () => {
    const r = engine.score(WEAK_BLOG, BLOG_DIMENSION_V1);
    expect(r.recommendations.length).toBeGreaterThan(0);
    const factorIds = new Set(r.factors.map((f) => f.id));
    for (const rec of r.recommendations) {
      if (rec.relatedFactorId) expect(factorIds.has(rec.relatedFactorId)).toBe(true);
      expect(rec.message.length).toBeGreaterThan(10);
    }
    // recommendations are priority-ordered
    const order = ["HIGH", "MEDIUM", "LOW"];
    const priorities = r.recommendations.map((x) => order.indexOf(x.priority));
    expect(priorities).toEqual([...priorities].sort((a, b) => a - b));
  });

  it("notes reduced confidence when no active Knowledge Pack backs the score", () => {
    const r = engine.score(WEAK_BLOG, BLOG_DIMENSION_V1);
    expect(r.recommendations.some((rec) => /Knowledge Pack/i.test(rec.message))).toBe(true);
  });

  it("does not fabricate keyword/brand results when none are supplied — it explains the gap", () => {
    const r = engine.score(WEAK_BLOG, BLOG_DIMENSION_V1);
    const kwFactor = r.factors.find((f) => f.id === "seo-keyword-coverage")!;
    expect(kwFactor.reason).toMatch(/no target keywords/i);
    const brandFactor = r.factors.find((f) => f.id === "business-brand-presence")!;
    expect(brandFactor.reason).toMatch(/Knowledge Pack|brand terms/i);
  });
});
