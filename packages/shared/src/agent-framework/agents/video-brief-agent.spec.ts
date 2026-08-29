import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VIDEO_BRIEF_AGENT_V1, VideoBriefAgentInput, VideoBriefAgentOutput } from "./video-brief-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = { topic: "Home EV charging", targetPlatform: "YOUTUBE_SHORTS", durationSecondsTarget: 45 };
const validOutput = {
  objective: "Show a new EV owner how to start home charging in under a minute.",
  audience: "New EV owners without a home charger yet",
  targetPlatform: "YOUTUBE_SHORTS",
  durationSeconds: 45,
  cta: "Book a free home charger install assessment.",
  rationale: "Shorts audiences need the payoff fast; 45s fits a single how-to beat.",
};

describe("VIDEO_BRIEF_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(VIDEO_BRIEF_AGENT_V1.identifier).toBe("video-brief-agent");
    expect(VIDEO_BRIEF_AGENT_V1.version).toBe(1);
    expect(VIDEO_BRIEF_AGENT_V1.type).toBe("content-generation");
    expect(VIDEO_BRIEF_AGENT_V1.timeoutMs).toBe(120_000);
  });

  describe("input validation", () => {
    it("accepts a full input", async () => {
      expect((await validate(plainToInstance(VideoBriefAgentInput, validInput))).length).toBe(0);
    });
    it("accepts input without the optional duration/objective hints", async () => {
      expect((await validate(plainToInstance(VideoBriefAgentInput, { topic: "x", targetPlatform: "YOUTUBE_LONG" }))).length).toBe(0);
    });
    it("rejects a missing topic/platform", async () => {
      expect((await validate(plainToInstance(VideoBriefAgentInput, { ...validInput, topic: undefined }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(VideoBriefAgentInput, { ...validInput, targetPlatform: undefined }))).length).toBeGreaterThan(0);
    });
  });

  describe("buildPrompt", () => {
    it("names the target platform and FR-VID-001 output fields", () => {
      const { prompt, systemInstructions } = VIDEO_BRIEF_AGENT_V1.buildPrompt(plainToInstance(VideoBriefAgentInput, validInput), blogAgentContext());
      expect(prompt).toContain("YOUTUBE_SHORTS");
      expect(prompt).toContain("objective, audience, targetPlatform, durationSeconds");
      expect(systemInstructions).toContain("SHORTS");
    });
  });

  describe("output schema", () => {
    it("accepts well-formed output", async () => {
      expect((await validate(plainToInstance(VideoBriefAgentOutput, validOutput))).length).toBe(0);
    });
    it("rejects a duration outside the 5–7200s bound", async () => {
      expect((await validate(plainToInstance(VideoBriefAgentOutput, { ...validOutput, durationSeconds: 2 }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(VideoBriefAgentOutput, { ...validOutput, durationSeconds: 10_000 }))).length).toBeGreaterThan(0);
    });
    it("rejects an empty objective/audience/cta/rationale", async () => {
      for (const field of ["objective", "audience", "cta", "rationale"] as const) {
        expect((await validate(plainToInstance(VideoBriefAgentOutput, { ...validOutput, [field]: "" }))).length).toBeGreaterThan(0);
      }
    });
  });
});
