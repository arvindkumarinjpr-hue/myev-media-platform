import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsString, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 7 Phase 7.2 — Video Recommendations Agent
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md "AI Recommendations": better hook,
 * better thumbnail concept, better title, shorter intro, stronger CTA,
 * repurpose opportunities).
 *
 * ADVISORY ONLY — non-blocking. Never invalidates a mandatory gate.
 * Does NOT implement cross-content repurposing execution (Module 15) —
 * it only surfaces the opportunity as a suggestion.
 */

export const RECOMMENDATION_KINDS = [
  "stronger_hook",
  "better_title",
  "better_thumbnail_concept",
  "shorter_intro",
  "stronger_cta",
  "repurpose_opportunity",
  "pacing",
  "other",
] as const;
export type RecommendationKind = (typeof RECOMMENDATION_KINDS)[number];

export class VideoRecommendation {
  @IsIn(RECOMMENDATION_KINDS)
  kind!: RecommendationKind;

  /** The concrete suggestion. */
  @IsString()
  @MinLength(1)
  suggestion!: string;

  /** Why it would help — grounded in the brief/script, no fabricated metrics. */
  @IsString()
  @MinLength(1)
  rationale!: string;
}

export class VideoRecommendationsAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  @IsString()
  @MinLength(1)
  targetPlatform!: string;

  @IsString()
  @MinLength(1)
  objective!: string;

  @IsString()
  @MinLength(1)
  hook!: string;

  @IsString()
  @MinLength(1)
  scriptSummary!: string;
}

export class VideoRecommendationsAgentOutput {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VideoRecommendation)
  recommendations!: VideoRecommendation[];
}

function buildPrompt(input: VideoRecommendationsAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const systemInstructions = [
    "You are the Video Recommendations Agent for an EV (electric vehicle) content platform.",
    "Given a video's brief and script, produce a short list of concrete, actionable improvement suggestions: a stronger hook, a better title, a better thumbnail concept, a shorter intro, a stronger CTA, a repurpose opportunity (e.g. cut a Short from this long video), or a pacing note.",
    "Each recommendation needs a kind, the concrete suggestion, and a one-line rationale grounded in the actual script. Do not fabricate view counts, retention curves, or A/B results. Do not rewrite the whole script.",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Target platform: ${input.targetPlatform}`,
    `Objective: ${input.objective}`,
    `Hook: ${input.hook}`,
    `Script summary: ${input.scriptSummary}`,
    "",
    "Respond with a single JSON object matching VideoRecommendationsAgentOutput exactly: recommendations (array of { kind, suggestion, rationale }). kind is one of: " +
      RECOMMENDATION_KINDS.join(" / ") +
      ".",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const VIDEO_RECOMMENDATIONS_AGENT_V1: AgentDefinition<VideoRecommendationsAgentInput, VideoRecommendationsAgentOutput> = {
  identifier: "video-recommendations-agent",
  version: 1,
  purpose: "Produces advisory improvement recommendations (hook / title / thumbnail / intro / CTA / repurpose / pacing) for a video — non-blocking, never invalidates a Quality Gate.",
  type: "content-generation",
  requiredKnowledgePackCapability: "industry_profile",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: VideoRecommendationsAgentInput,
  outputSchema: VideoRecommendationsAgentOutput,
  buildPrompt,
  timeoutMs: 120_000,
  executionPolicy: { maxAttempts: 3 },
};
