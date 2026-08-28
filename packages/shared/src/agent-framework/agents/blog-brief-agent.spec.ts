import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AI_EXECUTE_V1_MANIFEST } from "../../queue/jobs/ai-execute";
import { BLOG_BRIEF_AGENT_V1, BlogBriefAgentInput, BlogBriefAgentOutput } from "./blog-brief-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validOutput = {
  searchIntent: "informational",
  targetAudience: "New EV owners setting up home charging",
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger", "ev charging cost"],
  ctaObjective: "Book a home charger installation assessment",
  rationale: "The topic is a how-to question from buyers who have not yet installed a charger; informational intent with a soft conversion to an assessment.",
};

describe("BLOG_BRIEF_AGENT_V1", () => {
  it("registers under the expected identifier/version/provider/type", () => {
    expect(BLOG_BRIEF_AGENT_V1.identifier).toBe("blog-brief-agent");
    expect(BLOG_BRIEF_AGENT_V1.version).toBe(1);
    expect(BLOG_BRIEF_AGENT_V1.providerPreference.provider).toBe("openai");
    expect(BLOG_BRIEF_AGENT_V1.type).toBe("content-generation");
    expect(BLOG_BRIEF_AGENT_V1.outputSchema).toBe(BlogBriefAgentOutput);
    expect(BLOG_BRIEF_AGENT_V1.inputSchema).toBe(BlogBriefAgentInput);
  });

  it("declares a timeout within the ai.execute.v1 manifest ceiling", () => {
    expect(BLOG_BRIEF_AGENT_V1.timeoutMs).toBeGreaterThan(0);
    expect(BLOG_BRIEF_AGENT_V1.timeoutMs).toBeLessThanOrEqual(AI_EXECUTE_V1_MANIFEST.timeout);
  });

  describe("input validation", () => {
    it("accepts a minimal input (topic only)", async () => {
      const errs = await validate(plainToInstance(BlogBriefAgentInput, { topic: "Home EV charging" }));
      expect(errs).toHaveLength(0);
    });

    it("rejects a missing/empty topic", async () => {
      expect((await validate(plainToInstance(BlogBriefAgentInput, {}))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogBriefAgentInput, { topic: "" }))).length).toBeGreaterThan(0);
    });

    it("rejects an unknown search intent", async () => {
      const errs = await validate(plainToInstance(BlogBriefAgentInput, { topic: "x", searchIntent: "curiosity" }));
      expect(errs.length).toBeGreaterThan(0);
    });
  });

  describe("buildPrompt", () => {
    it("includes the topic, KP keyword sets, and the response-shape instruction; honours caller hints", () => {
      const { prompt, systemInstructions } = BLOG_BRIEF_AGENT_V1.buildPrompt(
        plainToInstance(BlogBriefAgentInput, { topic: "Home EV charging", primaryKeyword: "home ev charging", businessObjective: "installation leads" }),
        blogAgentContext(),
      );
      expect(prompt).toContain("Home EV charging");
      expect(prompt).toContain("home ev charging");
      expect(prompt).toContain("installation leads");
      expect(prompt).toContain("BlogBriefAgentOutput");
      expect(systemInstructions).toContain("home ev charging, level 2 charger");
      expect(systemInstructions).toContain("Do NOT invent search-volume");
    });

    it("does not leak absent KP keyword sets", () => {
      const { systemInstructions } = BLOG_BRIEF_AGENT_V1.buildPrompt(
        plainToInstance(BlogBriefAgentInput, { topic: "x" }),
        blogAgentContext({ keywords: [] }),
      );
      expect(systemInstructions).not.toContain("KNOWLEDGE PACK KEYWORD SETS");
    });
  });

  describe("output schema", () => {
    it("accepts well-formed output", async () => {
      expect((await validate(plainToInstance(BlogBriefAgentOutput, validOutput))).length).toBe(0);
    });

    it("rejects malformed / missing required fields (no fabricated defaults)", async () => {
      expect((await validate(plainToInstance(BlogBriefAgentOutput, { ...validOutput, primaryKeyword: "" }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogBriefAgentOutput, { ...validOutput, ctaObjective: undefined }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogBriefAgentOutput, { ...validOutput, searchIntent: "nope" }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogBriefAgentOutput, { ...validOutput, secondaryKeywords: "a,b" }))).length).toBeGreaterThan(0);
    });
  });

  it("has no postProcessOutput (nothing to structurally repair at this stage)", () => {
    expect(BLOG_BRIEF_AGENT_V1.postProcessOutput).toBeUndefined();
  });
});
