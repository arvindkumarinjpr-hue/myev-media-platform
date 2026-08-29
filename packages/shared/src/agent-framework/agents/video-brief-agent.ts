import "reflect-metadata";
import { IsInt, IsOptional, IsString, Max, Min, MinLength } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 7 Phase 7.2 — Video Brief Agent
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md "1. Video Brief Generator"; FRD
 * FR-VID-001).
 *
 * Lives in packages/shared for the same reason the Blog agents do:
 * apps/api and apps/worker each register their own AgentRegistry but MUST
 * register the exact same AgentDefinition object.
 *
 * FR-VID-001 output fields (frozen): objective, audience, target
 * platform, duration, CTA. The output schema carries ONLY those (plus a
 * short rationale for explainability). No AI provider SDK is touched
 * here; execution goes through the existing AIProviderRegistry via the
 * generic ai.execute.v1 worker processor, which already gates ADR-004
 * (an ACTIVE Knowledge Pack version) for every agent.
 */

/** The frozen "Supported Outputs" list — kept in sync with the Prisma
 * `VideoTargetPlatform` enum (apps/api). */
export const VIDEO_TARGET_PLATFORMS = [
  "YOUTUBE_LONG",
  "YOUTUBE_SHORTS",
  "INSTAGRAM_REEL",
  "FACEBOOK_REEL",
  "SQUARE_SOCIAL",
  "LANDSCAPE_PRESENTATION",
] as const;
export type VideoTargetPlatform = (typeof VIDEO_TARGET_PLATFORMS)[number];

export class VideoBriefAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  @IsString()
  @MinLength(1)
  targetPlatform!: string;

  /** Optional caller hint — the pipeline passes the value locked onto
   * video_scripts when present. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(7200)
  durationSecondsTarget?: number;

  @IsOptional()
  @IsString()
  businessObjective?: string;
}

export class VideoBriefAgentOutput {
  /** FR-VID-001 "objective". */
  @IsString()
  @MinLength(1)
  objective!: string;

  /** FR-VID-001 "audience". */
  @IsString()
  @MinLength(1)
  audience!: string;

  /** FR-VID-001 "platform" — echoed/normalised from input. */
  @IsString()
  @MinLength(1)
  targetPlatform!: string;

  /** FR-VID-001 "duration" — the recommended runtime in seconds. */
  @IsInt()
  @Min(5)
  @Max(7200)
  durationSeconds!: number;

  /** FR-VID-001 "CTA". */
  @IsString()
  @MinLength(1)
  cta!: string;

  /** One or two sentences: why this objective/audience/length for this
   * platform, grounded in the topic + Knowledge Pack — explainability,
   * not a new frozen field. */
  @IsString()
  @MinLength(1)
  rationale!: string;
}

function buildPrompt(input: VideoBriefAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const brand = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";

  const systemInstructions = [
    "You are the Video Brief Agent for an EV (electric vehicle) content platform.",
    "Produce a tight video brief a script writer will build from: a one-line objective, the target audience, the target platform, a recommended duration in seconds, and the call-to-action.",
    "Match the duration and framing to the target platform: YOUTUBE_SHORTS / INSTAGRAM_REEL / FACEBOOK_REEL are short vertical videos (typically 15–60s); YOUTUBE_LONG is long-form landscape; SQUARE_SOCIAL and LANDSCAPE_PRESENTATION sit in between.",
    "If the caller supplied a duration target or a business objective, honour it unless it is clearly wrong for the platform; otherwise derive the best value.",
    "Do not invent view counts, watch-time figures, or platform algorithm claims.",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
    context.publishingStrategy && Object.keys(context.publishingStrategy).length > 0 ? `PUBLISHING STRATEGY: ${JSON.stringify(context.publishingStrategy)}` : "",
    brand ? `BRAND GUIDELINES: ${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Video topic: ${input.topic}`,
    `Target platform: ${input.targetPlatform}`,
    input.durationSecondsTarget ? `Caller-suggested duration (seconds): ${input.durationSecondsTarget}` : "",
    input.businessObjective ? `Business objective / desired CTA: ${input.businessObjective}` : "",
    "",
    "Respond with a single JSON object matching VideoBriefAgentOutput exactly: objective, audience, targetPlatform, durationSeconds (integer), cta, rationale.",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const VIDEO_BRIEF_AGENT_V1: AgentDefinition<VideoBriefAgentInput, VideoBriefAgentOutput> = {
  identifier: "video-brief-agent",
  version: 1,
  purpose: "Produces a structured video brief (objective, audience, target platform, duration, CTA) grounded in the topic and the active Knowledge Pack — FR-VID-001.",
  type: "content-generation",
  requiredKnowledgePackCapability: "industry_profile",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: VideoBriefAgentInput,
  outputSchema: VideoBriefAgentOutput,
  buildPrompt,
  // No frozen FRD §21.1 figure for video brief generation — documented
  // implementation default (matches the Blog brief/outline agents), well
  // under the ai.execute.v1 manifest ceiling.
  timeoutMs: 120_000,
  executionPolicy: { maxAttempts: 3 },
};
