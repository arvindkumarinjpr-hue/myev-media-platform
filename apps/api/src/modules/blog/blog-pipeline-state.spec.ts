import { deriveStage, emptyPipelineState, isPublishReady, readPipelineState, unmetReviewGates, writePipelineState } from "./blog-pipeline-state";
import type { BlogPipelineState } from "./blog-pipeline.types";

const KP = "11111111-1111-1111-1111-111111111111";

function fullyReady(): BlogPipelineState {
  const s = emptyPipelineState(KP);
  s.brief = { ...s.brief, status: "APPROVED", artifact: { searchIntent: "informational", targetAudience: "x", primaryKeyword: "k", secondaryKeywords: [], ctaObjective: "c", rationale: "r" } };
  s.outline = { ...s.outline, status: "APPROVED", artifact: { h1: "H", sections: [{ level: 2, heading: "a", purpose: "p" }], faqPlan: [] } };
  s.draft = { ...s.draft, status: "READY", contentVersionPublicId: "v1", artifact: { introduction: "i", bodySections: [{ level: 2, heading: "a", content: "c" }], conclusion: "c", cta: "cta", faqs: [] } };
  s.seo = { ...s.seo, status: "READY", blogArticlePublicId: "b1", artifact: { metaTitle: "m", metaDescription: "d", urlSlug: "s", schemaMarkup: { "@type": "Article" } } };
  s.internalLinking = { status: "COMPLETED", suggestions: [], reason: "engine_not_available", completedAt: new Date().toISOString() };
  s.qa = { status: "COMPLETED", checks: [], completedAt: new Date().toISOString() };
  s.scoring = { status: "COMPLETED", contentScorePublicId: "cs1", overallScore: 82, passThreshold: 70, passed: true, ranAt: new Date().toISOString() };
  return s;
}

describe("blog-pipeline-state", () => {
  it("round-trips through metadata, preserving unrelated keys", () => {
    const state = emptyPipelineState(KP);
    const bag = writePipelineState({ foo: "bar" }, state);
    expect(bag.foo).toBe("bar");
    expect(readPipelineState(bag)).toEqual(state);
  });

  it("returns null for an item never started as a pipeline", () => {
    expect(readPipelineState({})).toBeNull();
    expect(readPipelineState(null)).toBeNull();
    expect(readPipelineState({ blogPipeline: { nope: true } })).toBeNull();
  });

  it("merges an older/partial stored shape onto the current skeleton (no undefined stages)", () => {
    const partial = { blogPipeline: { knowledgePackVersionId: KP, brief: { status: "READY" } } };
    const state = readPipelineState(partial)!;
    expect(state.outline.status).toBe("PENDING");
    expect(state.scoring.status).toBe("PENDING");
    expect(state.brief.status).toBe("READY");
  });

  it("unmetReviewGates lists every gate for a fresh pipeline and none for a fully-ready one", () => {
    expect(unmetReviewGates(emptyPipelineState(KP)).length).toBeGreaterThan(0);
    expect(unmetReviewGates(fullyReady())).toEqual([]);
  });

  it("unmetReviewGates flags a below-threshold score specifically", () => {
    const s = fullyReady();
    s.scoring = { ...s.scoring, passed: false };
    expect(unmetReviewGates(s)).toEqual(["content_score_passed"]);
  });

  it("deriveStage walks the pipeline and respects the content-item lifecycle status", () => {
    expect(deriveStage(emptyPipelineState(KP), "IN_PROGRESS")).toBe("BRIEF");
    const ready = fullyReady();
    expect(deriveStage(ready, "IN_PROGRESS")).toBe("READY_FOR_REVIEW");
    expect(deriveStage(ready, "REVIEW")).toBe("IN_REVIEW");
    expect(deriveStage(ready, "APPROVED")).toBe("PUBLISH_READY");
  });

  it("isPublishReady is true only for an APPROVED content item", () => {
    expect(isPublishReady("APPROVED")).toBe(true);
    expect(isPublishReady("REVIEW")).toBe(false);
    expect(isPublishReady("IN_PROGRESS")).toBe(false);
  });
});
