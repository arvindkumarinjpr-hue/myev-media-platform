import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SOCIAL_CAPTION_AGENT_V1, SocialCaptionAgentInput, SocialCaptionAgentOutput } from "./social-caption-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = { sourceContentType: "BLOG", sourceTitle: "Home EV Charging Guide", sourceSummary: "A complete walkthrough of setting up Level 2 home charging.", platform: "FACEBOOK" };
const validOutput = { caption: "Charging your EV at home is easier than you think — here's how to get set up.", ctaObjective: "Encourage readers to ask questions in the comments." };

describe("SOCIAL_CAPTION_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(SOCIAL_CAPTION_AGENT_V1.identifier).toBe("social-caption-agent");
    expect(SOCIAL_CAPTION_AGENT_V1.timeoutMs).toBeGreaterThan(0);
  });

  describe("input schema", () => {
    it("accepts a full valid input", async () => {
      expect((await validate(plainToInstance(SocialCaptionAgentInput, validInput))).length).toBe(0);
    });

    it("rejects an unsupported sourceContentType", async () => {
      const errors = await validate(plainToInstance(SocialCaptionAgentInput, { ...validInput, sourceContentType: "SOCIAL_POST" }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects an unsupported platform", async () => {
      const errors = await validate(plainToInstance(SocialCaptionAgentInput, { ...validInput, platform: "LINKEDIN" }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects an empty sourceSummary", async () => {
      const errors = await validate(plainToInstance(SocialCaptionAgentInput, { ...validInput, sourceSummary: "" }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("output schema", () => {
    it("accepts a well-formed caption with an optional ctaObjective", async () => {
      expect((await validate(plainToInstance(SocialCaptionAgentOutput, validOutput))).length).toBe(0);
    });

    it("accepts a caption with no ctaObjective at all", async () => {
      expect((await validate(plainToInstance(SocialCaptionAgentOutput, { caption: "A real caption." }))).length).toBe(0);
    });

    it("rejects an empty caption", async () => {
      const errors = await validate(plainToInstance(SocialCaptionAgentOutput, { caption: "" }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("postProcessOutput — no fabricated destination URL", () => {
    it("passes through a plain-text ctaObjective unchanged", () => {
      const output = plainToInstance(SocialCaptionAgentOutput, validOutput);
      expect(SOCIAL_CAPTION_AGENT_V1.postProcessOutput!(output, plainToInstance(SocialCaptionAgentInput, validInput))).toEqual(output);
    });

    it("throws when ctaObjective contains a URL", () => {
      const output = plainToInstance(SocialCaptionAgentOutput, { caption: "A real caption.", ctaObjective: "Visit https://example.com/charge to learn more." });
      expect(() => SOCIAL_CAPTION_AGENT_V1.postProcessOutput!(output, plainToInstance(SocialCaptionAgentInput, validInput))).toThrow(/URL/);
    });

    it("throws when ctaObjective contains a bare www. host", () => {
      const output = plainToInstance(SocialCaptionAgentOutput, { caption: "A real caption.", ctaObjective: "See www.example.com for details." });
      expect(() => SOCIAL_CAPTION_AGENT_V1.postProcessOutput!(output, plainToInstance(SocialCaptionAgentInput, validInput))).toThrow(/URL/);
    });
  });

  it("buildPrompt forbids fabricated facts/URLs and includes brand guidelines", () => {
    const { prompt, systemInstructions } = SOCIAL_CAPTION_AGENT_V1.buildPrompt(plainToInstance(SocialCaptionAgentInput, validInput), blogAgentContext());
    expect(systemInstructions).toContain("Do not fabricate");
    expect(systemInstructions).toContain("practical, expert, encouraging");
    expect(prompt).toContain("FACEBOOK");
  });
});
