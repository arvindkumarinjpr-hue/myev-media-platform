import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VIDEO_SCRIPT_AGENT_V1, VideoScriptAgentInput, VideoScriptAgentOutput } from "./video-script-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = {
  topic: "Home EV charging",
  targetPlatform: "YOUTUBE_SHORTS",
  objective: "Show a fast home-charging setup",
  audience: "New EV owners",
  durationSeconds: 45,
  cta: "Book an assessment",
};

const validOutput = {
  hook: "Charging your EV at home is easier than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Hook", narration: "Charging your EV at home is easier than you think.", purpose: "stop the scroll" },
    { order: 2, id: "seg-2", label: "Setup", narration: "Plug in, pick a schedule, done.", purpose: "show the steps" },
  ],
  cta: "Book a free install assessment.",
};

describe("VIDEO_SCRIPT_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(VIDEO_SCRIPT_AGENT_V1.identifier).toBe("video-script-agent");
    expect(VIDEO_SCRIPT_AGENT_V1.version).toBe(1);
    expect(VIDEO_SCRIPT_AGENT_V1.timeoutMs).toBe(240_000);
  });

  describe("input validation", () => {
    it("accepts a full input", async () => {
      expect((await validate(plainToInstance(VideoScriptAgentInput, validInput))).length).toBe(0);
    });
    it("rejects a missing objective/audience/duration", async () => {
      for (const missing of ["objective", "audience", "durationSeconds"] as const) {
        expect((await validate(plainToInstance(VideoScriptAgentInput, { ...validInput, [missing]: undefined }))).length).toBeGreaterThan(0);
      }
    });
  });

  describe("buildPrompt", () => {
    it("gives short-form guidance for a Shorts/Reel platform and long-form guidance otherwise", () => {
      const short = VIDEO_SCRIPT_AGENT_V1.buildPrompt(plainToInstance(VideoScriptAgentInput, validInput), blogAgentContext());
      expect(short.systemInstructions).toContain("SHORT vertical video");

      const long = VIDEO_SCRIPT_AGENT_V1.buildPrompt(plainToInstance(VideoScriptAgentInput, { ...validInput, targetPlatform: "YOUTUBE_LONG" }), blogAgentContext());
      expect(long.systemInstructions).toContain("long-form landscape video");
      expect(long.systemInstructions).not.toContain("SHORT vertical video");
    });

    it("does not ask for visual directions (the scene planner's job)", () => {
      const { systemInstructions } = VIDEO_SCRIPT_AGENT_V1.buildPrompt(plainToInstance(VideoScriptAgentInput, validInput), blogAgentContext());
      expect(systemInstructions).toContain("Do not include visual directions");
    });
  });

  describe("output schema + postProcessOutput", () => {
    it("accepts well-formed output and renders a scriptBody", () => {
      const parsed = plainToInstance(VideoScriptAgentOutput, validOutput);
      const result = VIDEO_SCRIPT_AGENT_V1.postProcessOutput!(parsed, plainToInstance(VideoScriptAgentInput, validInput));
      expect(result.scriptBody).toContain("HOOK:");
      expect(result.scriptBody).toContain("[seg-1]");
      expect(result.scriptBody).toContain("[seg-2]");
    });

    it("requires at least 2 segments", async () => {
      const errors = await validate(plainToInstance(VideoScriptAgentOutput, { ...validOutput, segments: [validOutput.segments[0]] }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("postProcessOutput rejects a non-contiguous segment order", () => {
      const bad = plainToInstance(VideoScriptAgentOutput, { ...validOutput, segments: [validOutput.segments[0], { ...validOutput.segments[1], order: 3, id: "seg-3" }] });
      expect(() => VIDEO_SCRIPT_AGENT_V1.postProcessOutput!(bad, plainToInstance(VideoScriptAgentInput, validInput))).toThrow(/contiguous/);
    });

    it("postProcessOutput rejects a duplicate segment id", () => {
      const bad = plainToInstance(VideoScriptAgentOutput, { ...validOutput, segments: [validOutput.segments[0], { ...validOutput.segments[1], id: "seg-1" }] });
      expect(() => VIDEO_SCRIPT_AGENT_V1.postProcessOutput!(bad, plainToInstance(VideoScriptAgentInput, validInput))).toThrow(/duplicate/);
    });

    it("postProcessOutput rejects a segment id that doesn't match its order", () => {
      const bad = plainToInstance(VideoScriptAgentOutput, { ...validOutput, segments: [{ ...validOutput.segments[0], id: "seg-9" }, validOutput.segments[1]] });
      expect(() => VIDEO_SCRIPT_AGENT_V1.postProcessOutput!(bad, plainToInstance(VideoScriptAgentInput, validInput))).toThrow(/does not match its order/);
    });

    it("preserves a caller-supplied scriptBody rather than overwriting it", () => {
      const withBody = plainToInstance(VideoScriptAgentOutput, { ...validOutput, scriptBody: "custom rendered body" });
      const result = VIDEO_SCRIPT_AGENT_V1.postProcessOutput!(withBody, plainToInstance(VideoScriptAgentInput, validInput));
      expect(result.scriptBody).toBe("custom rendered body");
    });
  });
});
