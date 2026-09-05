import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { HASHTAG_AGENT_V1, HashtagAgentInput, HashtagAgentOutput, normalizeHashtags } from "./hashtag-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = { sourceSummary: "A complete walkthrough of setting up Level 2 home charging.", caption: "Charging your EV at home is easier than you think.", platform: "INSTAGRAM" };
const validOutput = { hashtags: ["#ev", "#evcharging"] };

describe("HASHTAG_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(HASHTAG_AGENT_V1.identifier).toBe("hashtag-agent");
    expect(HASHTAG_AGENT_V1.timeoutMs).toBeGreaterThan(0);
  });

  describe("input schema", () => {
    it("accepts a full valid input", async () => {
      expect((await validate(plainToInstance(HashtagAgentInput, validInput))).length).toBe(0);
    });

    it("rejects an unsupported platform", async () => {
      const errors = await validate(plainToInstance(HashtagAgentInput, { ...validInput, platform: "TIKTOK" }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects an empty caption", async () => {
      const errors = await validate(plainToInstance(HashtagAgentInput, { ...validInput, caption: "" }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  describe("output schema", () => {
    it("accepts a well-formed structured array", async () => {
      expect((await validate(plainToInstance(HashtagAgentOutput, validOutput))).length).toBe(0);
    });

    it("rejects an empty hashtags array", async () => {
      const errors = await validate(plainToInstance(HashtagAgentOutput, { hashtags: [] }));
      expect(errors.length).toBeGreaterThan(0);
    });

    it("rejects a single comma-separated string instead of an array (Part J's own explicit prohibition)", async () => {
      const errors = await validate(plainToInstance(HashtagAgentOutput, { hashtags: "#ev, #evcharging" }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });

  it("buildPrompt requires a leading '#' and forbids inventing a platform limit", () => {
    const { prompt, systemInstructions } = HASHTAG_AGENT_V1.buildPrompt(plainToInstance(HashtagAgentInput, validInput), blogAgentContext());
    expect(systemInstructions).toContain('start with "#"');
    expect(systemInstructions).toContain("Do not invent a platform hashtag-count limit");
    expect(prompt).toContain("INSTAGRAM");
  });
});

describe("normalizeHashtags", () => {
  it("adds a leading '#' to a hashtag missing one", () => {
    expect(normalizeHashtags(["ev"])).toEqual(["#ev"]);
  });

  it("deduplicates case-insensitively, keeping the first occurrence's casing", () => {
    expect(normalizeHashtags(["#EV", "#ev", "#Ev"])).toEqual(["#EV"]);
  });

  it("strips internal whitespace", () => {
    expect(normalizeHashtags(["# electric vehicle"])).toEqual(["#electricvehicle"]);
  });

  it("drops empty/whitespace-only/bare-hash entries", () => {
    expect(normalizeHashtags(["#ev", "", "   ", "#"])).toEqual(["#ev"]);
  });

  it("preserves order of first occurrence", () => {
    expect(normalizeHashtags(["#b", "#a", "#b", "#c"])).toEqual(["#b", "#a", "#c"]);
  });

  it("returns an empty array when every input is unusable", () => {
    expect(normalizeHashtags(["", "  ", "#"])).toEqual([]);
  });
});
