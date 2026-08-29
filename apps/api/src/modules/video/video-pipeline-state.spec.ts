import { deriveStage, emptyPipelineState, hasVideoPipeline, isPublishReady, readPipelineState, unmetReviewGates, writePipelineState } from "./video-pipeline-state";
import type { VideoPipelineState } from "./video-pipeline.types";

const KP = "11111111-1111-1111-1111-111111111111";
const VS = "22222222-2222-2222-2222-222222222222";

function fullyReady(): VideoPipelineState {
  const s = emptyPipelineState(KP, VS);
  s.brief = { ...s.brief, status: "READY", artifact: { objective: "o" } };
  s.script = { ...s.script, status: "APPROVED", artifact: { body: "b" }, approvedAt: new Date().toISOString(), approvedByUserPublicId: "u1" };
  s.scenePlan = { ...s.scenePlan, status: "READY", artifact: { scenes: [] } };
  s.assets = { ...s.assets, status: "READY", scenes: [], missingScenes: [], completedAt: new Date().toISOString() };
  s.voice = { ...s.voice, status: "READY", audioAssetPublicId: "a1" };
  s.subtitles = { ...s.subtitles, status: "READY", subtitleAssetPublicId: "sub1" };
  s.render = { ...s.render, status: "READY", renderJobPublicId: "rj1", renderedVideoPublicId: "rv1", attempt: 1 };
  s.qa = { status: "COMPLETED", checks: [], completedAt: new Date().toISOString() };
  s.seo = { ...s.seo, status: "READY", videoScriptPublicId: VS, artifact: { metaTitle: "m" } };
  return s;
}

describe("video-pipeline-state", () => {
  it("round-trips through metadata, preserving unrelated keys", () => {
    const state = emptyPipelineState(KP, VS);
    const bag = writePipelineState({ foo: "bar" }, state);
    expect(bag.foo).toBe("bar");
    expect(readPipelineState(bag)).toEqual(state);
  });

  it("returns null for an item never started as a pipeline", () => {
    expect(readPipelineState({})).toBeNull();
    expect(readPipelineState(null)).toBeNull();
    expect(readPipelineState({ videoPipeline: { nope: true } })).toBeNull();
    // knowledgePackVersionId present but videoScriptPublicId missing → still null
    expect(readPipelineState({ videoPipeline: { knowledgePackVersionId: KP } })).toBeNull();
  });

  it("hasVideoPipeline recognises the bag without fully parsing it", () => {
    expect(hasVideoPipeline({ videoPipeline: { anything: true } })).toBe(true);
    expect(hasVideoPipeline({})).toBe(false);
    expect(hasVideoPipeline(null)).toBe(false);
    expect(hasVideoPipeline({ blogPipeline: { knowledgePackVersionId: KP } })).toBe(false);
  });

  it("merges an older/partial stored shape onto the current skeleton (no undefined stages)", () => {
    const partial = { videoPipeline: { knowledgePackVersionId: KP, videoScriptPublicId: VS, brief: { status: "READY" } } };
    const state = readPipelineState(partial)!;
    expect(state.script.status).toBe("PENDING");
    expect(state.render.status).toBe("PENDING");
    expect(state.qa.status).toBe("PENDING");
    expect(state.brief.status).toBe("READY");
  });

  it("unmetReviewGates lists every pre-review gate for a fresh pipeline and none for a fully-ready one", () => {
    expect(unmetReviewGates(emptyPipelineState(KP, VS))).toEqual([
      "script_approved",
      "assets_available",
      "voice_generated",
      "rendering_successful",
      "qa_passed",
      "seo_complete",
    ]);
    expect(unmetReviewGates(fullyReady())).toEqual([]);
  });

  it("deriveStage walks the pipeline and respects the content-item lifecycle status", () => {
    expect(deriveStage(emptyPipelineState(KP, VS), "IN_PROGRESS")).toBe("BRIEF");
    const ready = fullyReady();
    expect(deriveStage(ready, "IN_PROGRESS")).toBe("READY_FOR_REVIEW");
    expect(deriveStage(ready, "REVIEW")).toBe("IN_REVIEW");
    expect(deriveStage(ready, "APPROVED")).toBe("PUBLISH_READY");
  });

  it("deriveStage stops at the first incomplete stage", () => {
    const s = fullyReady();
    s.render = { ...s.render, status: "PENDING" };
    expect(deriveStage(s, "IN_PROGRESS")).toBe("RENDER");
    s.voice = { ...s.voice, status: "PENDING" };
    expect(deriveStage(s, "IN_PROGRESS")).toBe("VOICE");
    s.script = { ...s.script, status: "READY" }; // generated but not approved
    expect(deriveStage(s, "IN_PROGRESS")).toBe("SCRIPT");
  });

  it("isPublishReady is true only for an APPROVED content item", () => {
    expect(isPublishReady("APPROVED")).toBe(true);
    expect(isPublishReady("REVIEW")).toBe(false);
    expect(isPublishReady("RENDERING")).toBe(false);
    expect(isPublishReady("IN_PROGRESS")).toBe(false);
  });

  it("emptyPipelineState records both the KP version and the backing video_scripts row", () => {
    const s = emptyPipelineState(KP, VS);
    expect(s.knowledgePackVersionId).toBe(KP);
    expect(s.videoScriptPublicId).toBe(VS);
  });
});
