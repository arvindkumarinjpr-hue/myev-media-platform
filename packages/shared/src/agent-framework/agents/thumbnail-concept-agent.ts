import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 7 Phase 7.2 — Thumbnail Concept Agent
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md "AI Recommendations → Better thumbnail
 * concept"; Video Automation Engine doc AI Agent #8 "Thumbnail Agent —
 * thumbnail concepts, text suggestions, CTR ideas").
 *
 * TEXT ONLY — no image generation (that is Phase 7.4). Produces a small
 * set of thumbnail concepts a designer or a later image agent can work
 * from. ADVISORY: the pipeline never blocks a mandatory Quality Gate on
 * this stage, and a failure here does not fail the video.
 */

export class ThumbnailConcept {
  /** A short name for the concept — e.g. "Shocked reaction + price tag". */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  /** The visual direction: subject, framing, colour, focal point. */
  @IsString()
  @MinLength(1)
  visualDirection!: string;

  /** Suggested overlay text — kept very short (thumbnail-legible). */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  overlayText!: string;

  /** Composition guidance — rule-of-thirds placement, face size, contrast. */
  @IsString()
  @MinLength(1)
  composition!: string;

  /** Why this concept should earn clicks — the CTR hypothesis. */
  @IsString()
  @MinLength(1)
  ctrHypothesis!: string;
}

export class ThumbnailConceptAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  @IsString()
  @MinLength(1)
  targetPlatform!: string;

  @IsString()
  @MinLength(1)
  hook!: string;

  @IsString()
  @MinLength(1)
  objective!: string;

  @IsString()
  @MinLength(1)
  audience!: string;
}

export class ThumbnailConceptAgentOutput {
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => ThumbnailConcept)
  concepts!: ThumbnailConcept[];
}

function buildPrompt(input: ThumbnailConceptAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const brand = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";

  const systemInstructions = [
    "You are the Thumbnail Concept Agent for an EV (electric vehicle) content platform.",
    "Given a video's topic, hook, and audience, propose 2–5 distinct thumbnail concepts. For each: a short title, the visual direction, a very short overlay text (a few words, big and legible), composition guidance, and a one-line CTR hypothesis.",
    "Keep overlay text under ~5 words. Favour high contrast, one clear subject, and an emotional or curiosity hook. Concepts must be describable to a designer — do not output an image.",
    "Do not promise specific view counts or click-through rates.",
    brand ? `BRAND GUIDELINES (colour, logo, tone): ${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Target platform: ${input.targetPlatform}`,
    `Hook: ${input.hook}`,
    `Objective: ${input.objective}`,
    `Audience: ${input.audience}`,
    "",
    "Respond with a single JSON object matching ThumbnailConceptAgentOutput exactly: concepts (array of { title, visualDirection, overlayText, composition, ctrHypothesis }).",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const THUMBNAIL_CONCEPT_AGENT_V1: AgentDefinition<ThumbnailConceptAgentInput, ThumbnailConceptAgentOutput> = {
  identifier: "thumbnail-concept-agent",
  version: 1,
  purpose: "Produces 2–5 text-only thumbnail concepts (visual direction, overlay text, composition, CTR hypothesis) for a video — advisory, never blocks a Quality Gate.",
  type: "content-generation",
  requiredKnowledgePackCapability: "brand_guidelines",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: ThumbnailConceptAgentInput,
  outputSchema: ThumbnailConceptAgentOutput,
  buildPrompt,
  // Documented implementation default, under the 360s manifest ceiling.
  timeoutMs: 120_000,
  executionPolicy: { maxAttempts: 3 },
};
