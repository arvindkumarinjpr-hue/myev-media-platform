import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BLOG_OUTLINE_AGENT_V1, BlogOutlineAgentInput, BlogOutlineAgentOutput } from "./blog-outline-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = {
  topic: "Home EV charging",
  searchIntent: "informational",
  targetAudience: "New EV owners",
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger"],
  ctaObjective: "Book an install assessment",
};

const validOutput = {
  h1: "The Complete Guide to Home EV Charging",
  sections: [
    { level: 2, heading: "Why charge at home", purpose: "Establish the cost and convenience case" },
    { level: 2, heading: "Choosing a charger", purpose: "Help the reader pick a Level 2 unit" },
    { level: 3, heading: "Installation steps", purpose: "Set expectations for the electrical work" },
  ],
  faqPlan: ["How much does home charging cost?", "Do I need a permit?"],
};

describe("BLOG_OUTLINE_AGENT_V1", () => {
  // The timeoutMs-vs-manifest relationship (strictly below the ai.execute.v1
  // manifest's outer timeout — never equal) is enforced generically for
  // every registered production agent in agent-timeout-invariant.spec.ts.
  it("registers correctly and declares a positive timeout", () => {
    expect(BLOG_OUTLINE_AGENT_V1.identifier).toBe("blog-outline-agent");
    expect(BLOG_OUTLINE_AGENT_V1.version).toBe(1);
    expect(BLOG_OUTLINE_AGENT_V1.timeoutMs).toBeGreaterThan(0);
  });

  describe("input validation", () => {
    it("accepts a full approved-brief input", async () => {
      expect((await validate(plainToInstance(BlogOutlineAgentInput, validInput))).length).toBe(0);
    });

    it("rejects missing brief fields", async () => {
      for (const missing of ["topic", "searchIntent", "primaryKeyword", "ctaObjective"] as const) {
        const bad = { ...validInput, [missing]: undefined };
        expect((await validate(plainToInstance(BlogOutlineAgentInput, bad))).length).toBeGreaterThan(0);
      }
    });
  });

  describe("buildPrompt", () => {
    it("includes brief context, KP SEO rules, and the response-shape instruction", () => {
      const { prompt, systemInstructions } = BLOG_OUTLINE_AGENT_V1.buildPrompt(plainToInstance(BlogOutlineAgentInput, validInput), blogAgentContext());
      expect(prompt).toContain("Home EV charging");
      expect(prompt).toContain("home ev charging");
      expect(prompt).toContain("Book an install assessment");
      expect(prompt).toContain("BlogOutlineAgentOutput");
      expect(systemInstructions).toContain("KNOWLEDGE PACK SEO RULES");
      expect(systemInstructions).toContain("Do not write article prose");
    });
  });

  describe("output schema", () => {
    it("accepts a well-formed outline", async () => {
      expect((await validate(plainToInstance(BlogOutlineAgentOutput, validOutput))).length).toBe(0);
    });

    it("accepts an empty FAQ plan (some topics genuinely have none)", async () => {
      expect((await validate(plainToInstance(BlogOutlineAgentOutput, { ...validOutput, faqPlan: [] }))).length).toBe(0);
    });

    it("rejects malformed sections and missing H1", async () => {
      expect((await validate(plainToInstance(BlogOutlineAgentOutput, { ...validOutput, h1: "" }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogOutlineAgentOutput, { ...validOutput, sections: [] }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogOutlineAgentOutput, { ...validOutput, sections: [{ level: 1, heading: "x", purpose: "y" }] }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogOutlineAgentOutput, { ...validOutput, sections: [{ level: 2, heading: "", purpose: "y" }] }))).length).toBeGreaterThan(0);
    });
  });
});
