import { readFileSync } from "fs";
import { join } from "path";
import { ContentScoringEngine } from "./content-scoring-engine";
import { ContentDimensionRegistryBuilder } from "./content-dimension-registry";
import { SCORE_CATEGORIES } from "./score-category";
import type { ScoringInput } from "./scoring-input";
import { BLOG_DIMENSION_V1 } from "./dimensions/blog-dimension";
import { makeSyntheticDimension } from "./testing/synthetic-dimension";

/**
 * MODULE_ROADMAP_V1.0.md §11 — the MANDATORY type-agnosticism gate.
 *
 * These tests are the enforcement mechanism: they must prove the generic
 * Content Scoring Engine is content-type-agnostic before Module 6 can be
 * considered complete, and that Module 7 can later add Video/Thumbnail
 * scoring WITHOUT rewriting Blog or the engine.
 */
describe("§11 type-agnosticism gate", () => {
  const engine = new ContentScoringEngine();

  it("the generic engine source contains no content-type branching", () => {
    const engineSrc = readFileSync(join(__dirname, "content-scoring-engine.ts"), "utf8");
    const compositeSrc = readFileSync(join(__dirname, "composite-score.ts"), "utf8");
    const registrySrc = readFileSync(join(__dirname, "content-dimension-registry.ts"), "utf8");
    for (const src of [engineSrc, compositeSrc, registrySrc]) {
      // No literal reference to any concrete content type or dimension name.
      expect(src).not.toMatch(/\b(BLOG|VIDEO|THUMBNAIL|SHORT|REEL|NEWSLETTER|SOCIAL_POST)\b/);
      expect(src.toLowerCase()).not.toMatch(/\bblog(?:-| |_)?(dimension|score|agent)\b/);
    }
  });

  it("a synthetic NON-Blog dimension registers and scores end-to-end through the same public contract", () => {
    const registry = new ContentDimensionRegistryBuilder().register(makeSyntheticDimension({ appliesTo: ["PODCAST"] })).freeze();
    const input: ScoringInput = { contentType: "PODCAST", title: "How to charge an EV at home overnight", bodyText: "y".repeat(80), knowledgePackActive: true };

    const dimension = registry.resolveForContentType(input.contentType); // same resolution path Blog uses
    const result = engine.score(input, dimension); // same engine call Blog uses

    expect(result.dimension.name).toBe("synthetic");
    expect(result.dimension.label).toBe("Synthetic Score");
    expect(SCORE_CATEGORIES.every((c) => typeof result.categoryScores[c] === "number")).toBe(true);
    expect(result.overallScore).toBeGreaterThanOrEqual(0);
    expect(result.overallScore).toBeLessThanOrEqual(100);
  });

  it("the Blog dimension goes through the exact same registry + engine path — no special-casing", () => {
    const registry = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).freeze();
    const input: ScoringInput = { contentType: "BLOG", title: "The complete guide to home EV charging", bodyText: "The best way to charge. ".repeat(50), knowledgePackActive: true };

    const dimension = registry.resolveForContentType(input.contentType);
    const result = engine.score(input, dimension);
    expect(result.dimension.name).toBe("blog");
    expect(result.dimension.label).toBe("Blog Score");
  });

  it("Blog and a synthetic dimension can be registered side by side and each resolves to its own content type", () => {
    const registry = new ContentDimensionRegistryBuilder()
      .register(BLOG_DIMENSION_V1)
      .register(makeSyntheticDimension({ appliesTo: ["PODCAST"] }))
      .freeze();
    expect(registry.resolveForContentType("BLOG").name).toBe("blog");
    expect(registry.resolveForContentType("PODCAST").name).toBe("synthetic");
    expect(registry.registeredNames()).toEqual(["blog", "synthetic"]);
  });

  it("no Video or Thumbnail dimension is shipped in Phase 6.1", () => {
    // Guard against premature Module 7 work leaking into this phase.
    const barrel = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    expect(barrel).not.toMatch(/video-dimension|thumbnail-dimension/);
    let threw = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require("./dimensions/video-dimension");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
