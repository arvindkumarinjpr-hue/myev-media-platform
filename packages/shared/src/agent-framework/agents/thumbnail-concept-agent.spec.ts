import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { THUMBNAIL_CONCEPT_AGENT_V1, ThumbnailConceptAgentInput, ThumbnailConceptAgentOutput } from "./thumbnail-concept-agent";
import { blogAgentContext } from "./testing/blog-agent-context";

const validInput = { topic: "Home EV charging", targetPlatform: "YOUTUBE_LONG", hook: "Charging at home is easier than you think.", objective: "Teach setup", audience: "New EV owners" };
const validOutput = {
  concepts: [
    { title: "Shocked reaction", visualDirection: "Owner pointing at a low electric bill", overlayText: "SO CHEAP?!", composition: "Face left third, bill right third, high contrast", ctrHypothesis: "Curiosity gap on the price." },
    { title: "Before/after", visualDirection: "Split screen gas pump vs charger", overlayText: "NEVER AGAIN", composition: "Vertical split, bold red X on gas side", ctrHypothesis: "Visual contrast reads instantly." },
  ],
};

describe("THUMBNAIL_CONCEPT_AGENT_V1", () => {
  it("registers correctly", () => {
    expect(THUMBNAIL_CONCEPT_AGENT_V1.identifier).toBe("thumbnail-concept-agent");
    expect(THUMBNAIL_CONCEPT_AGENT_V1.timeoutMs).toBeGreaterThan(0);
  });

  it("accepts a full input", async () => {
    expect((await validate(plainToInstance(ThumbnailConceptAgentInput, validInput))).length).toBe(0);
  });

  it("buildPrompt asks for 2–5 text-only concepts, never an image", () => {
    const { systemInstructions } = THUMBNAIL_CONCEPT_AGENT_V1.buildPrompt(plainToInstance(ThumbnailConceptAgentInput, validInput), blogAgentContext());
    expect(systemInstructions).toContain("do not output an image");
  });

  describe("output schema", () => {
    it("accepts 2 well-formed concepts", async () => {
      expect((await validate(plainToInstance(ThumbnailConceptAgentOutput, validOutput))).length).toBe(0);
    });
    it("rejects a single concept (min 2)", async () => {
      const errors = await validate(plainToInstance(ThumbnailConceptAgentOutput, { concepts: [validOutput.concepts[0]] }));
      expect(errors.length).toBeGreaterThan(0);
    });
    it("rejects overlay text over 40 characters", async () => {
      const errors = await validate(plainToInstance(ThumbnailConceptAgentOutput, { concepts: [{ ...validOutput.concepts[0], overlayText: "A".repeat(41) }, validOutput.concepts[1]] }));
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
