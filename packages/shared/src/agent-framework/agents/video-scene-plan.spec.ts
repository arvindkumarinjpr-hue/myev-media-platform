import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VIDEO_SCENE_PLAN_SCHEMA_VERSION, VideoScenePlanV1, validateVideoScenePlan } from "./video-scene-plan";

function scene(overrides: Record<string, unknown> = {}) {
  return {
    order: 1,
    sceneId: "scene-1",
    scriptSegmentRef: "seg-1",
    startSeconds: 0,
    durationSeconds: 5,
    visualInstruction: "Close-up of a charger plugging in.",
    transition: "cut",
    assetRequirements: [{ kind: "video_clip", description: "Charger plugging in", sourceHint: "stock" }],
    ...overrides,
  };
}

function plan(scenes: Record<string, unknown>[]): Record<string, unknown> {
  return { scenePlanVersion: VIDEO_SCENE_PLAN_SCHEMA_VERSION, targetPlatform: "YOUTUBE_LONG", scenes };
}

describe("VideoScenePlanV1 — schema (D8 contract)", () => {
  it("accepts a well-formed single-scene plan", async () => {
    const errors = await validate(plainToInstance(VideoScenePlanV1, plan([scene()])));
    expect(errors).toEqual([]);
  });

  it("rejects a wrong scenePlanVersion", async () => {
    const errors = await validate(plainToInstance(VideoScenePlanV1, { ...plan([scene()]), scenePlanVersion: 2 }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a malformed sceneId", async () => {
    const errors = await validate(plainToInstance(VideoScenePlanV1, plan([scene({ sceneId: "scene-one" })])));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown transition", async () => {
    const errors = await validate(plainToInstance(VideoScenePlanV1, plan([scene({ transition: "wipeout" })])));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects a scene with zero asset requirements", async () => {
    const errors = await validate(plainToInstance(VideoScenePlanV1, plan([scene({ assetRequirements: [] })])));
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects an unknown asset requirement kind/sourceHint", async () => {
    const errors = await validate(plainToInstance(VideoScenePlanV1, plan([scene({ assetRequirements: [{ kind: "drone_shot", description: "x", sourceHint: "stock" }] })])));
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("validateVideoScenePlan — cross-field structural checks", () => {
  const twoScenes = [
    scene({ order: 1, sceneId: "scene-1", scriptSegmentRef: "seg-1", startSeconds: 0 }),
    scene({ order: 2, sceneId: "scene-2", scriptSegmentRef: "seg-2", startSeconds: 5 }),
  ];

  it("passes for a contiguous, fully-covering, monotonic plan", () => {
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan(twoScenes)), { scriptSegmentIds: ["seg-1", "seg-2"] });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it("rejects a non-contiguous order (e.g. 1, 3)", () => {
    const scenes = [scene({ order: 1, sceneId: "scene-1" }), scene({ order: 3, sceneId: "scene-3" })];
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan(scenes)), { scriptSegmentIds: ["seg-1"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("contiguous"))).toBe(true);
  });

  it("rejects a duplicate sceneId", () => {
    const scenes = [scene({ order: 1, sceneId: "scene-1" }), scene({ order: 2, sceneId: "scene-1" })];
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan(scenes)), { scriptSegmentIds: ["seg-1"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate sceneId"))).toBe(true);
  });

  it("rejects a sceneId that doesn't match its order", () => {
    const scenes = [scene({ order: 1, sceneId: "scene-2" })];
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan(scenes)), { scriptSegmentIds: ["seg-1"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("does not match its order"))).toBe(true);
  });

  it("rejects a scene referencing an unknown script segment (every scene MUST map to a segment)", () => {
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan([scene({ scriptSegmentRef: "seg-99" })])), { scriptSegmentIds: ["seg-1"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unknown script segment"))).toBe(true);
  });

  it("rejects a plan that leaves a script segment uncovered", () => {
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan([scene({ scriptSegmentRef: "seg-1" })])), { scriptSegmentIds: ["seg-1", "seg-2"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("not covered by any scene"))).toBe(true);
  });

  it("rejects a non-monotonic timeline (a later scene starts before an earlier one)", () => {
    const scenes = [scene({ order: 1, sceneId: "scene-1", startSeconds: 5 }), scene({ order: 2, sceneId: "scene-2", scriptSegmentRef: "seg-2", startSeconds: 2 })];
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan(scenes)), { scriptSegmentIds: ["seg-1", "seg-2"] });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("non-decreasing"))).toBe(true);
  });

  it("multiple scenes may cover the same segment (one segment, several shots) as long as every segment is covered", () => {
    const scenes = [
      scene({ order: 1, sceneId: "scene-1", scriptSegmentRef: "seg-1", startSeconds: 0 }),
      scene({ order: 2, sceneId: "scene-2", scriptSegmentRef: "seg-1", startSeconds: 3 }),
    ];
    const result = validateVideoScenePlan(plainToInstance(VideoScenePlanV1, plan(scenes)), { scriptSegmentIds: ["seg-1"] });
    expect(result).toEqual({ ok: true, errors: [] });
  });
});
