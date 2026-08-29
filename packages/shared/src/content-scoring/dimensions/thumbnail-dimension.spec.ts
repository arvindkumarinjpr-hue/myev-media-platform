import { ContentScoringEngine } from "../content-scoring-engine";
import { ContentDimensionRegistryBuilder } from "../content-dimension-registry";
import { SCORE_CATEGORIES } from "../score-category";
import type { ScoringInput } from "../scoring-input";
import { VIDEO_DIMENSION_V1 } from "./video-dimension";
import { THUMBNAIL_DIMENSION_V1 } from "./thumbnail-dimension";

const engine = new ContentScoringEngine();

const STRONG_CONCEPT: ScoringInput = {
  contentType: "VIDEO_THUMBNAIL_CONCEPT",
  title: "Shocked reaction at the electric bill",
  bodyText: "Close-up of an owner's shocked face next to a tiny electric bill, warm kitchen lighting, high contrast red arrow pointing at the number.",
  metadata: { metaTitle: "SO CHEAP?!", metaDescription: "A concrete, surprising number earns more clicks than a vague promise of savings." },
  targetKeywords: ["home ev charging"],
  primaryKeyword: "home ev charging",
  brandTerms: ["EVolt"],
  knowledgePackActive: true,
};

const EMPTY_CONCEPT: ScoringInput = {
  contentType: "VIDEO_THUMBNAIL_CONCEPT",
  title: "",
  knowledgePackActive: false,
};

describe("THUMBNAIL_DIMENSION_V1", () => {
  it("registers correctly and is NOT resolvable via resolveForContentType('VIDEO') — avoids ambiguity with VIDEO_DIMENSION_V1", () => {
    expect(THUMBNAIL_DIMENSION_V1.name).toBe("thumbnail");
    expect(THUMBNAIL_DIMENSION_V1.appliesTo).toEqual(["VIDEO_THUMBNAIL_CONCEPT"]);
    expect(THUMBNAIL_DIMENSION_V1.dimensionScoreLabel).toBe("Thumbnail Score");

    const registry = new ContentDimensionRegistryBuilder().register(VIDEO_DIMENSION_V1).register(THUMBNAIL_DIMENSION_V1).freeze();
    expect(registry.resolveForContentType("VIDEO").name).toBe("video"); // unambiguous — never throws "ambiguous"
    expect(registry.resolve("thumbnail", 1)).toBe(THUMBNAIL_DIMENSION_V1); // reachable only by explicit name
    // "VIDEO_THUMBNAIL_CONCEPT" is a logical identifier for THIS registry
    // lookup mechanism only — no real content_items.content_type column
    // value is ever literally this string (the frozen ContentType enum
    // has no such member), so resolveForContentType is never reached
    // with it in production; VideoScoringService always calls resolve()
    // by name for this dimension, never resolveForContentType().
  });

  it("is deterministic — identical input yields byte-identical output", () => {
    expect(JSON.stringify(engine.score(STRONG_CONCEPT, THUMBNAIL_DIMENSION_V1))).toBe(JSON.stringify(engine.score(STRONG_CONCEPT, THUMBNAIL_DIMENSION_V1)));
  });

  it("covers all five universal categories with at least one factor each", () => {
    const evalResult = THUMBNAIL_DIMENSION_V1.evaluate(STRONG_CONCEPT);
    const covered = new Set(evalResult.categoryFactors.map((f) => f.category));
    for (const c of SCORE_CATEGORIES) expect(covered.has(c)).toBe(true);
    expect(evalResult.categoryFactors.every((f) => f.category !== null)).toBe(true);
    expect(evalResult.dimensionFactors.every((f) => f.category === null)).toBe(true);
  });

  it("never throws on an empty concept and never fabricates a passing score", () => {
    expect(() => THUMBNAIL_DIMENSION_V1.evaluate(EMPTY_CONCEPT)).not.toThrow();
    const r = engine.score(EMPTY_CONCEPT, THUMBNAIL_DIMENSION_V1);
    expect(r.dimension.score).toBe(0);
  });

  it("keeps every score and factor value within [0, 100]", () => {
    for (const input of [STRONG_CONCEPT, EMPTY_CONCEPT]) {
      const r = engine.score(input, THUMBNAIL_DIMENSION_V1);
      expect(r.overallScore).toBeGreaterThanOrEqual(0);
      expect(r.overallScore).toBeLessThanOrEqual(100);
      expect(r.dimension.score).toBeGreaterThanOrEqual(0);
      expect(r.dimension.score).toBeLessThanOrEqual(100);
      for (const f of r.factors) {
        expect(f.value).toBeGreaterThanOrEqual(0);
        expect(f.value).toBeLessThanOrEqual(100);
      }
    }
  });

  it("scores a complete concept meaningfully higher than an empty one", () => {
    const strong = engine.score(STRONG_CONCEPT, THUMBNAIL_DIMENSION_V1);
    const empty = engine.score(EMPTY_CONCEPT, THUMBNAIL_DIMENSION_V1);
    expect(strong.dimension.score).toBeGreaterThan(empty.dimension.score);
  });

  it("the Thumbnail Score covers the 4 frozen measures: visual clarity, text readability, CTR potential, brand consistency", () => {
    const evalResult = THUMBNAIL_DIMENSION_V1.evaluate(STRONG_CONCEPT);
    const ids = evalResult.dimensionFactors.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining(["thumbnail-visual-clarity", "thumbnail-text-readability", "thumbnail-ctr-potential", "thumbnail-brand-consistency"]));
  });

  it("never claims to assess a rendered image — every reason is explicit about text-only evaluation", () => {
    const evalResult = THUMBNAIL_DIMENSION_V1.evaluate(STRONG_CONCEPT);
    const visualClarity = evalResult.categoryFactors.find((f) => f.id === "quality-thumbnail-visual-clarity")!;
    expect(visualClarity.reason).toMatch(/does not.*rendered image|described concept only/i);
  });

  it("overlay text over the schema-enforced cap scores lower than a short, punchy one", () => {
    const longOverlay: ScoringInput = { ...STRONG_CONCEPT, metadata: { ...STRONG_CONCEPT.metadata, metaTitle: "A".repeat(40) } };
    const shortOverlay: ScoringInput = { ...STRONG_CONCEPT, metadata: { ...STRONG_CONCEPT.metadata, metaTitle: "SO CHEAP?!" } };
    const longValue = THUMBNAIL_DIMENSION_V1.evaluate(longOverlay).dimensionFactors.find((f) => f.id === "thumbnail-text-readability")!.value;
    const shortValue = THUMBNAIL_DIMENSION_V1.evaluate(shortOverlay).dimensionFactors.find((f) => f.id === "thumbnail-text-readability")!.value;
    expect(shortValue).toBeGreaterThan(longValue);
  });
});
