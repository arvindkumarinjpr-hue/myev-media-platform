import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AI_EXECUTE_V1_MANIFEST } from "../../queue/jobs/ai-execute";
import { BLOG_DRAFT_AGENT_V1, BlogDraftAgentInput, BlogDraftAgentOutput } from "./blog-draft-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = {
  topic: "Home EV charging",
  h1: "The Complete Guide to Home EV Charging",
  sections: [
    { level: 2, heading: "Why charge at home", purpose: "cost + convenience case" },
    { level: 2, heading: "Choosing a charger", purpose: "pick a Level 2 unit" },
  ],
  faqPlan: ["How much does home charging cost?"],
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger"],
  targetAudience: "New EV owners",
  ctaObjective: "Book an install assessment",
};

const validOutput = {
  introduction: "Charging at home is the cheapest, most convenient way to keep an EV ready.",
  bodySections: [
    { level: 2, heading: "Why charge at home", content: "A home Level 2 setup costs less per mile than public charging and is ready every morning." },
    { level: 2, heading: "Choosing a charger", content: "Look at amperage, cable length, and smart scheduling. For example, a 40A unit adds about 30 miles of range per hour." },
  ],
  conclusion: "Home charging pays for itself within a year for most drivers.",
  cta: "Book a free home charger installation assessment.",
  faqs: [{ question: "How much does home charging cost?", answer: "Typically a few hundred dollars to install plus your normal electricity rate." }],
};

describe("BLOG_DRAFT_AGENT_V1", () => {
  it("registers correctly and applies the FROZEN FRD §21.1 Blog-draft timeout of 5 minutes", () => {
    expect(BLOG_DRAFT_AGENT_V1.identifier).toBe("blog-draft-agent");
    expect(BLOG_DRAFT_AGENT_V1.version).toBe(1);
    expect(BLOG_DRAFT_AGENT_V1.timeoutMs).toBe(300_000);
    // The frozen timeout must be honourable — i.e. not silently capped
    // below by the manifest.
    expect(BLOG_DRAFT_AGENT_V1.timeoutMs).toBeLessThanOrEqual(AI_EXECUTE_V1_MANIFEST.timeout);
  });

  describe("input validation", () => {
    it("accepts a full approved-outline input", async () => {
      expect((await validate(plainToInstance(BlogDraftAgentInput, validInput))).length).toBe(0);
    });

    it("rejects an empty outline / missing brief context", async () => {
      expect((await validate(plainToInstance(BlogDraftAgentInput, { ...validInput, sections: [] }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogDraftAgentInput, { ...validInput, h1: undefined }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogDraftAgentInput, { ...validInput, primaryKeyword: "" }))).length).toBeGreaterThan(0);
    });
  });

  describe("buildPrompt", () => {
    it("renders the approved outline, brand guidelines, planned FAQs, and the response-shape instruction", () => {
      const { prompt, systemInstructions } = BLOG_DRAFT_AGENT_V1.buildPrompt(plainToInstance(BlogDraftAgentInput, validInput), blogAgentContext());
      expect(prompt).toContain("H2 Why charge at home");
      expect(prompt).toContain("How much does home charging cost?");
      expect(prompt).toContain("BlogDraftAgentOutput");
      expect(systemInstructions).toContain("BRAND GUIDELINES");
      expect(systemInstructions).toContain("Do not invent statistics");
      expect(systemInstructions).toContain("Do not add sections that are not in the outline");
    });

    it("tells the model to return an empty faqs array when no FAQ was planned", () => {
      const { prompt } = BLOG_DRAFT_AGENT_V1.buildPrompt(plainToInstance(BlogDraftAgentInput, { ...validInput, faqPlan: [] }), blogAgentContext());
      expect(prompt).toContain("No FAQ planned");
    });
  });

  describe("output schema", () => {
    it("accepts a well-formed draft", async () => {
      expect((await validate(plainToInstance(BlogDraftAgentOutput, validOutput))).length).toBe(0);
    });

    it("rejects a draft missing intro/conclusion/CTA or with empty body", async () => {
      expect((await validate(plainToInstance(BlogDraftAgentOutput, { ...validOutput, introduction: "" }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogDraftAgentOutput, { ...validOutput, cta: undefined }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogDraftAgentOutput, { ...validOutput, bodySections: [] }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(BlogDraftAgentOutput, { ...validOutput, faqs: [{ question: "q", answer: "" }] }))).length).toBeGreaterThan(0);
    });
  });
});
