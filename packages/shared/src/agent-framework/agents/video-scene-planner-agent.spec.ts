import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VIDEO_SCENE_PLANNER_AGENT_V1, VideoScenePlannerAgentInput, VideoScenePlannerAgentOutput } from "./video-scene-planner-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = {
  topic: "Home EV charging",
  targetPlatform: "YOUTUBE_SHORTS",
  durationSeconds: 45,
  hook: "Charging at home is easier than you think.",
  segments: [
    { id: "seg-1", order: 1, label: "Hook", narration: "Charging at home is easier than you think.", purpose: "stop the scroll" },
    { id: "seg-2", order: 2, label: "Setup", narration: "Plug in, pick a schedule, done.", purpose: "show the steps" },
  ],
};

function validPlan() {
  return {
    scenePlanVersion: 1,
    targetPlatform: "YOUTUBE_SHORTS",
    scenes: [
      {
        order: 1,
        sceneId: "scene-1",
        scriptSegmentRef: "seg-1",
        startSeconds: 0,
        durationSeconds: 3,
        visualInstruction: "Close on hands plugging in a charger.",
        transition: "cut",
        assetRequirements: [{ kind: "video_clip", description: "Plugging in a Level 2 charger", sourceHint: "stock" }],
      },
      {
        order: 2,
        sceneId: "scene-2",
        scriptSegmentRef: "seg-2",
        startSeconds: 3,
        durationSeconds: 3,
        visualInstruction: "Phone app showing a charge schedule.",
        transition: "fade",
        assetRequirements: [{ kind: "image", description: "Charging app UI", sourceHint: "ai_generated" }],
      },
    ],
  };
}

describe("VIDEO_SCENE_PLANNER_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(VIDEO_SCENE_PLANNER_AGENT_V1.identifier).toBe("video-scene-planner-agent");
    expect(VIDEO_SCENE_PLANNER_AGENT_V1.version).toBe(1);
    expect(VIDEO_SCENE_PLANNER_AGENT_V1.timeoutMs).toBe(180_000);
  });

  describe("input validation", () => {
    it("accepts a full input", async () => {
      expect((await validate(plainToInstance(VideoScenePlannerAgentInput, validInput))).length).toBe(0);
    });
    it("requires at least 2 segments (matches the script contract)", async () => {
      const errors = await validate(plainToInstance(VideoScenePlannerAgentInput, { ...validInput, segments: [validInput.segments[0]] }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("buildPrompt", () => {
    it("echoes the segments and the fixed schema version", () => {
      const { prompt, systemInstructions } = VIDEO_SCENE_PLANNER_AGENT_V1.buildPrompt(plainToInstance(VideoScenePlannerAgentInput, validInput), blogAgentContext());
      expect(prompt).toContain("seg-1");
      expect(prompt).toContain("seg-2");
      expect(systemInstructions).toContain('"scenePlanVersion": 1');
    });
  });

  describe("output schema + postProcessOutput (wires validateVideoScenePlan)", () => {
    it("accepts a well-formed plan that covers every segment", () => {
      const parsed = plainToInstance(VideoScenePlannerAgentOutput, validPlan());
      expect(() => VIDEO_SCENE_PLANNER_AGENT_V1.postProcessOutput!(parsed, plainToInstance(VideoScenePlannerAgentInput, validInput))).not.toThrow();
    });

    it("rejects (fails the job) a plan that leaves a segment uncovered", () => {
      const plan = validPlan();
      plan.scenes = [plan.scenes[0]]; // seg-2 never covered
      const parsed = plainToInstance(VideoScenePlannerAgentOutput, plan);
      expect(() => VIDEO_SCENE_PLANNER_AGENT_V1.postProcessOutput!(parsed, plainToInstance(VideoScenePlannerAgentInput, validInput))).toThrow(/not covered/);
    });

    it("rejects (fails the job) a scene referencing a segment id the script never had", () => {
      const plan = validPlan();
      plan.scenes[0].scriptSegmentRef = "seg-99";
      const parsed = plainToInstance(VideoScenePlannerAgentOutput, plan);
      expect(() => VIDEO_SCENE_PLANNER_AGENT_V1.postProcessOutput!(parsed, plainToInstance(VideoScenePlannerAgentInput, validInput))).toThrow(/unknown script segment/);
    });

    it("schema rejects an empty scenes array", async () => {
      const errors = await validate(plainToInstance(VideoScenePlannerAgentOutput, { ...validPlan(), scenes: [] }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
