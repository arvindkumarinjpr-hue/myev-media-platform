import { readFileSync } from "fs";
import { join } from "path";
import { ContentScoringEngine } from "./content-scoring-engine";
import { ContentDimensionRegistryBuilder } from "./content-dimension-registry";
import { SCORE_CATEGORIES } from "./score-category";
import type { ScoringInput } from "./scoring-input";
import { BLOG_DIMENSION_V1 } from "./dimensions/blog-dimension";
import { VIDEO_DIMENSION_V1 } from "./dimensions/video-dimension";
import { THUMBNAIL_DIMENSION_V1 } from "./dimensions/thumbnail-dimension";
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

  it("Module 7 Phase 7.3 added Video and Thumbnail through this SAME §11 contract — no engine/registry edit, no Blog edit", () => {
    // The historical Phase 6.1 guard above ("no Video/Thumbnail shipped
    // yet") is now Phase 7.3's own proof of the promise it was guarding:
    // both new dimensions are registered and exported, and neither one
    // required touching content-scoring-engine.ts / composite-score.ts /
    // content-dimension-registry.ts (already proven above) or
    // blog-dimension.ts (proven by the byte-identical Blog assertion
    // below) to exist.
    const barrel = readFileSync(join(__dirname, "..", "index.ts"), "utf8");
    expect(barrel).toMatch(/video-dimension/);
    expect(barrel).toMatch(/thumbnail-dimension/);
    expect(VIDEO_DIMENSION_V1.name).toBe("video");
    expect(THUMBNAIL_DIMENSION_V1.name).toBe("thumbnail");
  });

  it("registering Video/Thumbnail alongside Blog leaves Blog's own scoring output byte-identical to a Blog-only registry", () => {
    const blogInput: ScoringInput = {
      contentType: "BLOG",
      title: "The complete guide to home EV charging",
      bodyText: "The best way to charge. ".repeat(50),
      knowledgePackActive: true,
    };
    const blogOnlyRegistry = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).freeze();
    const withVideoThumbnailRegistry = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).register(VIDEO_DIMENSION_V1).register(THUMBNAIL_DIMENSION_V1).freeze();

    const resultAlone = engine.score(blogInput, blogOnlyRegistry.resolveForContentType("BLOG"));
    const resultWithSiblings = engine.score(blogInput, withVideoThumbnailRegistry.resolveForContentType("BLOG"));
    expect(JSON.stringify(resultWithSiblings)).toBe(JSON.stringify(resultAlone));
  });

  it("VIDEO now resolves unambiguously to the Video dimension even with Thumbnail registered alongside it (no 'ambiguous' error)", () => {
    const registry = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).register(VIDEO_DIMENSION_V1).register(THUMBNAIL_DIMENSION_V1).freeze();
    expect(() => registry.resolveForContentType("VIDEO")).not.toThrow();
    expect(registry.resolveForContentType("VIDEO").name).toBe("video");
    expect(registry.registeredNames()).toEqual(["blog", "thumbnail", "video"]);
  });

  it("an unsupported content type (e.g. NEWSLETTER) still gets no dimension — Video/Thumbnail registration does not leak coverage to types they don't declare", () => {
    const registry = new ContentDimensionRegistryBuilder().register(BLOG_DIMENSION_V1).register(VIDEO_DIMENSION_V1).register(THUMBNAIL_DIMENSION_V1).freeze();
    expect(registry.hasContentType("NEWSLETTER")).toBe(false);
    expect(registry.hasContentType("SOCIAL_POST")).toBe(false);
    expect(registry.hasContentType("SHORT")).toBe(false);
    expect(registry.hasContentType("REEL")).toBe(false);
  });
});
