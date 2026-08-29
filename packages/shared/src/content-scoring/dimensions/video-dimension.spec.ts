import { ContentScoringEngine } from "../content-scoring-engine";
import { SCORE_CATEGORIES } from "../score-category";
import type { ScoringInput } from "../scoring-input";
import { VIDEO_DIMENSION_V1 } from "./video-dimension";

const engine = new ContentScoringEngine();

const STRONG_VIDEO: ScoringInput = {
  contentType: "VIDEO",
  title: "Home EV Charging: The Complete Setup Guide",
  bodyText: [
    "Did you know charging your EV at home is easier than you think?",
    "Plug in the Level 2 charger, pick a nightly schedule, and you're done — no more gas station stops.",
    "Most installs cost a few hundred dollars and pay for themselves within a year.",
    "Subscribe for more home charging tips and book a free assessment today.",
  ].join("\n\n"),
  headings: [
    { level: 2, text: "Hook" },
    { level: 2, text: "Setup" },
    { level: 2, text: "Costs" },
    { level: 2, text: "CTA" },
    { level: 3, text: "Intro" },
    { level: 3, text: "Why home charging" },
  ],
  mediaReferenceCount: 4,
  metadata: {
    metaTitle: "Home EV Charging: The Complete Setup Guide",
    metaDescription: "Everything you need to charge your EV at home — Level 2 chargers, install costs, and monthly savings.",
    hasSchemaMarkup: true,
  },
  targetKeywords: ["home ev charging", "level 2 charger", "ev charging cost"],
  primaryKeyword: "home ev charging",
  brandTerms: ["EVolt"],
  knowledgePackActive: true,
  targetPlatform: "YOUTUBE_LONG",
};

const EMPTY_VIDEO: ScoringInput = {
  contentType: "VIDEO",
  title: "New video",
  knowledgePackActive: false,
};

describe("VIDEO_DIMENSION_V1", () => {
  it("registers correctly and is separate from Blog", () => {
    expect(VIDEO_DIMENSION_V1.name).toBe("video");
    expect(VIDEO_DIMENSION_V1.appliesTo).toEqual(["VIDEO"]);
    expect(VIDEO_DIMENSION_V1.dimensionScoreLabel).toBe("Video Score");
  });

  it("is deterministic — identical input yields byte-identical output", () => {
    expect(JSON.stringify(engine.score(STRONG_VIDEO, VIDEO_DIMENSION_V1))).toBe(JSON.stringify(engine.score(STRONG_VIDEO, VIDEO_DIMENSION_V1)));
  });

  it("covers all five universal categories with at least one factor each", () => {
    const evalResult = VIDEO_DIMENSION_V1.evaluate(STRONG_VIDEO);
    const covered = new Set(evalResult.categoryFactors.map((f) => f.category));
    for (const c of SCORE_CATEGORIES) expect(covered.has(c)).toBe(true);
    expect(evalResult.categoryFactors.every((f) => f.category !== null)).toBe(true);
    expect(evalResult.dimensionFactors.every((f) => f.category === null)).toBe(true);
  });

  it("does the same for a freshly-created item with NO artifacts yet (never throws, never fabricates)", () => {
    expect(() => VIDEO_DIMENSION_V1.evaluate(EMPTY_VIDEO)).not.toThrow();
    const evalResult = VIDEO_DIMENSION_V1.evaluate(EMPTY_VIDEO);
    const covered = new Set(evalResult.categoryFactors.map((f) => f.category));
    for (const c of SCORE_CATEGORIES) expect(covered.has(c)).toBe(true);
    // Honest "nothing available yet" reasons, not fabricated success.
    expect(evalResult.categoryFactors.some((f) => /no script|not yet|no .* available/i.test(f.reason))).toBe(true);
  });

  it("keeps every score and factor value within [0, 100]", () => {
    for (const input of [STRONG_VIDEO, EMPTY_VIDEO]) {
      const r = engine.score(input, VIDEO_DIMENSION_V1);
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

  it("scores a complete video meaningfully higher than an empty one", () => {
    const strong = engine.score(STRONG_VIDEO, VIDEO_DIMENSION_V1);
    const empty = engine.score(EMPTY_VIDEO, VIDEO_DIMENSION_V1);
    expect(strong.overallScore).toBeGreaterThan(empty.overallScore);
    expect(strong.dimension.score).toBeGreaterThan(empty.dimension.score);
  });

  it("the Video Score covers the 5 frozen measures: hook, script quality, retention, thumbnail (coarse), CTA", () => {
    const evalResult = VIDEO_DIMENSION_V1.evaluate(STRONG_VIDEO);
    const ids = evalResult.dimensionFactors.map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(["video-hook-strength", "video-script-quality", "video-retention-potential", "video-thumbnail-quality", "video-cta-effectiveness"]),
    );
  });

  it("the 'thumbnail quality' dimension factor is a fixed, honestly-labelled neutral value — never fabricated from evidence this dimension doesn't have", () => {
    const strongEval = VIDEO_DIMENSION_V1.evaluate(STRONG_VIDEO);
    const emptyEval = VIDEO_DIMENSION_V1.evaluate(EMPTY_VIDEO);
    const strongFactor = strongEval.dimensionFactors.find((f) => f.id === "video-thumbnail-quality")!;
    const emptyFactor = emptyEval.dimensionFactors.find((f) => f.id === "video-thumbnail-quality")!;
    expect(strongFactor.value).toBe(emptyFactor.value); // identical regardless of input — genuinely not evidence-derived
    expect(strongFactor.reason).toContain("separate Thumbnail Score");
  });

  it("uses targetPlatform for platform-aware length evaluation (short vs long form)", () => {
    const shortForm: ScoringInput = { ...STRONG_VIDEO, targetPlatform: "YOUTUBE_SHORTS" };
    const longForm: ScoringInput = { ...STRONG_VIDEO, targetPlatform: "YOUTUBE_LONG" };
    const shortFactor = VIDEO_DIMENSION_V1.evaluate(shortForm).categoryFactors.find((f) => f.id === "viral-platform-fit")!;
    const longFactor = VIDEO_DIMENSION_V1.evaluate(longForm).categoryFactors.find((f) => f.id === "viral-platform-fit")!;
    // Same short script scored against a SHORTS ideal vs a LONG ideal must differ.
    expect(shortFactor.value).not.toBe(longFactor.value);
  });

  it("does not throw and produces valid output when targetPlatform is entirely absent", () => {
    const noPlatform: ScoringInput = { ...STRONG_VIDEO, targetPlatform: undefined };
    expect(() => engine.score(noPlatform, VIDEO_DIMENSION_V1)).not.toThrow();
  });
});
