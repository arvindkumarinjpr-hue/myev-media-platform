import { ContentScoringEngine } from "./content-scoring-engine";
import type { ScoringInput } from "./scoring-input";
import { BLOG_DIMENSION_V1 } from "./dimensions/blog-dimension";
import { deserializeScoreResult, serializeScoreResult, serializeSeoBreakdown } from "./serialization";

const engine = new ContentScoringEngine();
const INPUT: ScoringInput = {
  contentType: "BLOG",
  title: "Home EV charging explained for new owners",
  bodyText: "A practical overview. ".repeat(40),
  headings: [
    { level: 1, text: "Home EV charging explained" },
    { level: 2, text: "The basics" },
    { level: 2, text: "FAQ" },
  ],
  faqQuestions: ["Is it cheaper than public charging?"],
  internalLinkCount: 1,
  externalLinkCount: 1,
  targetKeywords: ["home ev charging"],
  primaryKeyword: "home ev charging",
  knowledgePackActive: true,
};

describe("score-result serialization", () => {
  it("round-trips without loss", () => {
    const result = engine.score(INPUT, BLOG_DIMENSION_V1);
    const json = serializeScoreResult(result);
    const back = deserializeScoreResult(json);
    expect(back).toEqual(result);
  });

  it("produces byte-stable JSON for the same score (deterministic key + array ordering)", () => {
    const a = JSON.stringify(serializeScoreResult(engine.score(INPUT, BLOG_DIMENSION_V1)));
    const b = JSON.stringify(serializeScoreResult(engine.score(INPUT, BLOG_DIMENSION_V1)));
    expect(a).toBe(b);
  });

  it("category score keys are always in the canonical order", () => {
    const json = serializeScoreResult(engine.score(INPUT, BLOG_DIMENSION_V1));
    expect(Object.keys(json.categoryScores)).toEqual(["SEO", "VIRAL", "QUALITY", "ENGAGEMENT", "BUSINESS"]);
  });

  it("tags a schema version for forward-compatible persistence", () => {
    expect(serializeScoreResult(engine.score(INPUT, BLOG_DIMENSION_V1)).schemaVersion).toBe(1);
  });

  it("the SEO breakdown slice is individually retrievable and matches the SEO category score (FR-SEO-003)", () => {
    const result = engine.score(INPUT, BLOG_DIMENSION_V1);
    const seo = serializeSeoBreakdown(result);
    expect(seo.seoScore).toBe(result.categoryScores.SEO);
    expect(seo.factors.length).toBeGreaterThan(0);
    expect(seo.factors.every((f) => f.category === "SEO")).toBe(true);
  });
});
