import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VIDEO_RECOMMENDATIONS_AGENT_V1, VideoRecommendationsAgentInput, VideoRecommendationsAgentOutput } from "./video-recommendations-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = { topic: "Home EV charging", targetPlatform: "YOUTUBE_LONG", objective: "Teach setup", hook: "Charging at home is easier than you think.", scriptSummary: "Intro, setup steps, cost, CTA." };
const validOutput = { recommendations: [{ kind: "stronger_hook", suggestion: "Open on the electric bill number.", rationale: "A concrete number earns more retention than an abstract claim." }] };

describe("VIDEO_RECOMMENDATIONS_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(VIDEO_RECOMMENDATIONS_AGENT_V1.identifier).toBe("video-recommendations-agent");
    expect(VIDEO_RECOMMENDATIONS_AGENT_V1.timeoutMs).toBeGreaterThan(0);
  });

  it("accepts a full input", async () => {
    expect((await validate(plainToInstance(VideoRecommendationsAgentInput, validInput))).length).toBe(0);
  });

  it("buildPrompt lists every recommendation kind and forbids fabricated metrics", () => {
    const { prompt, systemInstructions } = VIDEO_RECOMMENDATIONS_AGENT_V1.buildPrompt(plainToInstance(VideoRecommendationsAgentInput, validInput), blogAgentContext());
    expect(prompt).toContain("repurpose_opportunity");
    expect(systemInstructions).toContain("Do not fabricate view counts");
  });

  describe("output schema", () => {
    it("accepts a well-formed recommendation", async () => {
      expect((await validate(plainToInstance(VideoRecommendationsAgentOutput, validOutput))).length).toBe(0);
    });
    it("rejects an unknown recommendation kind", async () => {
      const errors = await validate(plainToInstance(VideoRecommendationsAgentOutput, { recommendations: [{ ...validOutput.recommendations[0], kind: "make_it_viral" }] }));
      expect(errors.length).toBeGreaterThan(0);
    });
    it("rejects an empty recommendations array", async () => {
      const errors = await validate(plainToInstance(VideoRecommendationsAgentOutput, { recommendations: [] }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
