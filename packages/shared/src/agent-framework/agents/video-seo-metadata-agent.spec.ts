import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { VIDEO_SEO_METADATA_AGENT_V1, VideoSeoMetadataAgentInput, VideoSeoMetadataAgentOutput } from "./video-seo-metadata-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = {
  topic: "Home EV charging",
  targetPlatform: "YOUTUBE_LONG",
  objective: "Teach setup",
  audience: "New EV owners",
  durationSeconds: 300,
  hook: "Charging at home is easier than you think.",
  scriptSummary: "Intro, why home charging, choosing a charger, cost breakdown, CTA.",
  segmentOutline: [
    { label: "Hook", startSeconds: 0 },
    { label: "Why home charging", startSeconds: 10 },
  ],
};

const validOutput = {
  metaTitle: "Home EV Charging: The Complete Setup Guide",
  metaDescription: "Everything you need to charge your EV at home.",
  tags: ["ev charging", "home charger", "level 2 charger"],
  chapters: [
    { startSeconds: 0, title: "Intro" },
    { startSeconds: 10, title: "Why home charging" },
  ],
  hashtags: ["ev", "#homecharging"],
  schemaMarkup: { "@type": "VideoObject", name: "Home EV Charging: The Complete Setup Guide", description: "A guide to home EV charging.", duration: "PT5M0S" },
};

describe("VIDEO_SEO_METADATA_AGENT_V1", () => {
  it("registers correctly and applies the FROZEN FRD §21.1 SEO-pass timeout of 3 minutes", () => {
    expect(VIDEO_SEO_METADATA_AGENT_V1.identifier).toBe("video-seo-metadata-agent");
    expect(VIDEO_SEO_METADATA_AGENT_V1.type).toBe("seo");
    expect(VIDEO_SEO_METADATA_AGENT_V1.timeoutMs).toBe(180_000);
  });

  describe("input validation", () => {
    it("accepts a full input", async () => {
      expect((await validate(plainToInstance(VideoSeoMetadataAgentInput, validInput))).length).toBe(0);
    });
  });

  describe("buildPrompt", () => {
    it("is distinct from the Blog SEO prompt — asks for tags/chapters/hashtags/VideoObject, not a urlSlug", () => {
      const { prompt } = VIDEO_SEO_METADATA_AGENT_V1.buildPrompt(plainToInstance(VideoSeoMetadataAgentInput, validInput), blogAgentContext());
      expect(prompt).toContain("tags");
      expect(prompt).toContain("chapters");
      expect(prompt).toContain("hashtags");
      expect(prompt).toContain("VideoObject");
      expect(prompt).not.toContain("urlSlug");
    });
  });

  describe("output schema + postProcessOutput", () => {
    it("accepts well-formed output", async () => {
      expect((await validate(plainToInstance(VideoSeoMetadataAgentOutput, validOutput))).length).toBe(0);
    });

    it("normalises hashtags to a leading #", () => {
      const out = plainToInstance(VideoSeoMetadataAgentOutput, validOutput);
      const result = VIDEO_SEO_METADATA_AGENT_V1.postProcessOutput!(out, plainToInstance(VideoSeoMetadataAgentInput, validInput));
      expect(result.hashtags).toEqual(["#ev", "#homecharging"]);
    });

    it("sorts chapters by start time", () => {
      const shuffled = plainToInstance(VideoSeoMetadataAgentOutput, { ...validOutput, chapters: [validOutput.chapters[1], validOutput.chapters[0]] });
      const result = VIDEO_SEO_METADATA_AGENT_V1.postProcessOutput!(shuffled, plainToInstance(VideoSeoMetadataAgentInput, validInput));
      expect(result.chapters.map((c) => c.startSeconds)).toEqual([0, 10]);
    });

    it("throws when schemaMarkup is not a VideoObject", () => {
      const bad = plainToInstance(VideoSeoMetadataAgentOutput, { ...validOutput, schemaMarkup: { "@type": "Article", name: "x" } });
      expect(() => VIDEO_SEO_METADATA_AGENT_V1.postProcessOutput!(bad, plainToInstance(VideoSeoMetadataAgentInput, validInput))).toThrow(/VideoObject/);
    });

    it("throws when the first chapter does not start at 0", () => {
      const bad = plainToInstance(VideoSeoMetadataAgentOutput, { ...validOutput, chapters: [{ startSeconds: 5, title: "Late start" }] });
      expect(() => VIDEO_SEO_METADATA_AGENT_V1.postProcessOutput!(bad, plainToInstance(VideoSeoMetadataAgentInput, validInput))).toThrow(/first video chapter must start at 0/);
    });

    it("throws on non-increasing chapter offsets", () => {
      const bad = plainToInstance(VideoSeoMetadataAgentOutput, { ...validOutput, chapters: [{ startSeconds: 0, title: "A" }, { startSeconds: 0, title: "B" }] });
      expect(() => VIDEO_SEO_METADATA_AGENT_V1.postProcessOutput!(bad, plainToInstance(VideoSeoMetadataAgentInput, validInput))).toThrow(/strictly increasing/);
    });

    it("accepts an empty chapters array (valid for a very short video)", () => {
      const out = plainToInstance(VideoSeoMetadataAgentOutput, { ...validOutput, chapters: [] });
      expect(() => VIDEO_SEO_METADATA_AGENT_V1.postProcessOutput!(out, plainToInstance(VideoSeoMetadataAgentInput, validInput))).not.toThrow();
    });
  });
});
