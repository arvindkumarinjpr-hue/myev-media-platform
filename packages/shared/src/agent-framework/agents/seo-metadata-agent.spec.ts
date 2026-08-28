import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { AI_EXECUTE_V1_MANIFEST } from "../../queue/jobs/ai-execute";
import { SEO_METADATA_AGENT_V1, SeoMetadataAgentInput, SeoMetadataAgentOutput } from "./seo-metadata-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = {
  topic: "Home EV charging",
  title: "The Complete Guide to Home EV Charging",
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger"],
  articleSummary: "How to set up and pay for charging an EV at home, including chargers, install costs, and rebates.",
};

const validOutput = {
  metaTitle: "Home EV Charging Guide: Costs & Setup",
  metaDescription: "Everything you need to charge your EV at home — Level 2 chargers, install costs, and utility rebates.",
  urlSlug: "home-ev-charging-guide",
  schemaMarkup: { "@type": "Article", headline: "The Complete Guide to Home EV Charging" },
};

describe("SEO_METADATA_AGENT_V1", () => {
  it("registers correctly and applies the FROZEN FRD §21.1 SEO-pass timeout of 3 minutes", () => {
    expect(SEO_METADATA_AGENT_V1.identifier).toBe("seo-metadata-agent");
    expect(SEO_METADATA_AGENT_V1.version).toBe(1);
    expect(SEO_METADATA_AGENT_V1.type).toBe("seo");
    expect(SEO_METADATA_AGENT_V1.timeoutMs).toBe(180_000);
    expect(SEO_METADATA_AGENT_V1.timeoutMs).toBeLessThanOrEqual(AI_EXECUTE_V1_MANIFEST.timeout);
  });

  describe("input validation", () => {
    it("accepts a full input", async () => {
      expect((await validate(plainToInstance(SeoMetadataAgentInput, validInput))).length).toBe(0);
    });
    it("rejects missing title / keyword / summary", async () => {
      for (const missing of ["title", "primaryKeyword", "articleSummary", "topic"] as const) {
        expect((await validate(plainToInstance(SeoMetadataAgentInput, { ...validInput, [missing]: undefined }))).length).toBeGreaterThan(0);
      }
    });
  });

  describe("buildPrompt", () => {
    it("includes only the four required outputs and the KP SEO rules", () => {
      const { prompt, systemInstructions } = SEO_METADATA_AGENT_V1.buildPrompt(plainToInstance(SeoMetadataAgentInput, validInput), blogAgentContext());
      expect(prompt).toContain("The Complete Guide to Home EV Charging");
      expect(prompt).toContain("metaTitle, metaDescription, urlSlug, schemaMarkup");
      expect(systemInstructions).toContain("KNOWLEDGE PACK SEO RULES");
      expect(systemInstructions).toContain("Do not invent an author");
      // internal linking is explicitly NOT this agent's job
      expect((systemInstructions ?? "").toLowerCase()).not.toContain("internal link");
    });
  });

  describe("output schema + structural post-process", () => {
    it("accepts well-formed metadata", async () => {
      expect((await validate(plainToInstance(SeoMetadataAgentOutput, validOutput))).length).toBe(0);
      expect(() => SEO_METADATA_AGENT_V1.postProcessOutput!(plainToInstance(SeoMetadataAgentOutput, validOutput), plainToInstance(SeoMetadataAgentInput, validInput))).not.toThrow();
    });

    it("rejects a malformed slug (fails schema — never silently repaired)", async () => {
      for (const bad of ["Home EV Charging", "home_ev_charging", "home--ev", "-home-ev", "HOME-EV"]) {
        expect((await validate(plainToInstance(SeoMetadataAgentOutput, { ...validOutput, urlSlug: bad }))).length).toBeGreaterThan(0);
      }
    });

    it("rejects an empty meta title/description", async () => {
      expect((await validate(plainToInstance(SeoMetadataAgentOutput, { ...validOutput, metaTitle: "" }))).length).toBeGreaterThan(0);
      expect((await validate(plainToInstance(SeoMetadataAgentOutput, { ...validOutput, metaDescription: undefined }))).length).toBeGreaterThan(0);
    });

    it("post-process throws (job fails safely) when schemaMarkup has no @type", () => {
      const out = plainToInstance(SeoMetadataAgentOutput, { ...validOutput, schemaMarkup: { headline: "x" } });
      expect(() => SEO_METADATA_AGENT_V1.postProcessOutput!(out, plainToInstance(SeoMetadataAgentInput, validInput))).toThrow(/@type/);
    });

    it("post-process returns the output unchanged when valid (no fabrication)", () => {
      const out = plainToInstance(SeoMetadataAgentOutput, validOutput);
      expect(SEO_METADATA_AGENT_V1.postProcessOutput!(out, plainToInstance(SeoMetadataAgentInput, validInput))).toBe(out);
    });
  });
});
