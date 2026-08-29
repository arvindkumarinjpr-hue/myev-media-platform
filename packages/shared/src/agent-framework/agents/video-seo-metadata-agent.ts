import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsObject, IsString, Min, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 7 Phase 7.2 — Video SEO Metadata Agent
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md "9. SEO Engine": Title, Description,
 * Tags, Chapters, Hashtags; FRD FR-VID-009 dep FR-SEO-001 / FR-SEO-002).
 *
 * A thin, dedicated agent rather than a "VIDEO mode" bolted onto
 * SEO_METADATA_AGENT_V1: the Blog SEO contract centres on `urlSlug` +
 * `schema.org Article`, which do not apply to a video, and lacks
 * tags / chapters / hashtags entirely. Reusing it would mean making
 * `urlSlug` conditional and adding three video-only fields — contaminating
 * a frozen Module 6 contract to save one additive agent. This agent
 * produces exactly the frozen video SEO set and a `VideoObject` schema.
 *
 * FR-VID-009 Quality Gate #6 ("SEO Complete") is Phase 7.2 pipeline
 * orchestration (VideoPipelineService persists these onto video_scripts
 * and marks the gate), not enforced in this agent.
 *
 * FRD §21.1 frozen timeout — "Queue job timeout — SEO/Internal Linking
 * pass | 3 min" — applies to SEO metadata generation regardless of
 * content type; applied as `timeoutMs: 180_000`.
 */

export class VideoSeoChapter {
  /** Chapter start offset in seconds. YouTube requires the first at 0. */
  @IsInt()
  @Min(0)
  startSeconds!: number;

  @IsString()
  @MinLength(1)
  title!: string;
}

export class VideoSeoMetadataAgentInput {
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
  audience!: string;

  @IsInt()
  @Min(1)
  durationSeconds!: number;

  /** The approved script's hook — strong signal for a title/description. */
  @IsString()
  @MinLength(1)
  hook!: string;

  /** A short summary of the script (segment labels + first lines). */
  @IsString()
  @MinLength(1)
  scriptSummary!: string;

  /** Segment labels with their approximate start offsets — seeds chapters. */
  @IsArray()
  segmentOutline!: { label: string; startSeconds: number }[];
}

export class VideoSeoMetadataAgentOutput {
  @IsString()
  @MinLength(1)
  metaTitle!: string;

  @IsString()
  @MinLength(1)
  metaDescription!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  tags!: string[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VideoSeoChapter)
  chapters!: VideoSeoChapter[];

  @IsArray()
  @IsString({ each: true })
  hashtags!: string[];

  /** A schema.org VideoObject JSON-LD suggestion (FR-SEO-002).
   * `postProcessOutput` requires `@type === "VideoObject"` + a `name`. */
  @IsObject()
  schemaMarkup!: Record<string, unknown>;
}

/**
 * Deterministic structural checks class-validator can't express:
 *  - schemaMarkup must be a schema.org VideoObject with a non-empty name
 *  - if chapters are present, the first must start at 0 and they must be
 *    strictly increasing (YouTube chapter rules)
 *  - hashtags are normalised to a leading "#"
 */
function postProcessOutput(output: VideoSeoMetadataAgentOutput): VideoSeoMetadataAgentOutput {
  const schema = output.schemaMarkup as Record<string, unknown>;
  if (schema["@type"] !== "VideoObject") {
    throw new Error('video SEO schemaMarkup must be a schema.org object with "@type": "VideoObject"');
  }
  if (typeof schema.name !== "string" || schema.name.trim().length === 0) {
    throw new Error('video SEO schemaMarkup must include a non-empty "name"');
  }
  if (output.chapters.length > 0) {
    const sorted = [...output.chapters].sort((a, b) => a.startSeconds - b.startSeconds);
    if (sorted[0].startSeconds !== 0) throw new Error("the first video chapter must start at 0 seconds");
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startSeconds <= sorted[i - 1].startSeconds) throw new Error("video chapter start offsets must be strictly increasing");
    }
    output.chapters = sorted;
  }
  output.hashtags = output.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`));
  return output;
}

function buildPrompt(input: VideoSeoMetadataAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const seoRules = context.seoRules.length > 0 ? JSON.stringify(context.seoRules) : "";
  const outline = input.segmentOutline.map((s) => `- ${Math.round(s.startSeconds)}s: ${s.label}`).join("\n");

  const systemInstructions = [
    "You are the Video SEO Metadata Agent for an EV (electric vehicle) content platform.",
    "Given a finished video's brief and script summary, produce: a meta title, a meta description, a list of tags, timestamped chapters, hashtags, and a schema.org VideoObject JSON-LD object.",
    "The title should lead with the core subject and read naturally for the target platform. The description should summarise the video and invite a watch; put the most important line first.",
    "Chapters: the first must start at 0 seconds; keep offsets within the video's duration and strictly increasing. Use the segment outline as a seed. If the video is very short (a Short/Reel), chapters may be an empty array.",
    "Hashtags: 3–8, platform-appropriate, each a single token. Tags: 5–15 search phrases.",
    'The schema markup must be a valid schema.org "VideoObject" with at least "name" and "description"; include "duration" in ISO-8601 (e.g. "PT2M30S"). Do not invent an uploadDate, thumbnailUrl, contentUrl, or publisher you were not given.',
    seoRules ? `KNOWLEDGE PACK SEO RULES: ${seoRules}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Target platform: ${input.targetPlatform}`,
    `Objective: ${input.objective}`,
    `Audience: ${input.audience}`,
    `Duration (seconds): ${input.durationSeconds}`,
    `Hook: ${input.hook}`,
    `Script summary: ${input.scriptSummary}`,
    input.segmentOutline.length > 0 ? `Segment outline:\n${outline}` : "",
    "",
    'Respond with a single JSON object matching VideoSeoMetadataAgentOutput exactly: metaTitle, metaDescription, tags (array), chapters (array of { startSeconds, title }), hashtags (array), schemaMarkup (schema.org VideoObject).',
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const VIDEO_SEO_METADATA_AGENT_V1: AgentDefinition<VideoSeoMetadataAgentInput, VideoSeoMetadataAgentOutput> = {
  identifier: "video-seo-metadata-agent",
  version: 1,
  purpose: "Generates the frozen video SEO metadata set (title, description, tags, chapters, hashtags, schema.org VideoObject) for a finished video script — FR-VID-009 / FR-SEO-001 / FR-SEO-002.",
  type: "seo",
  requiredKnowledgePackCapability: "seo_rules",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: VideoSeoMetadataAgentInput,
  outputSchema: VideoSeoMetadataAgentOutput,
  buildPrompt,
  postProcessOutput,
  // FROZEN — FRD §21.1 "Queue job timeout — SEO/Internal Linking pass | 3 min".
  timeoutMs: 180_000,
  executionPolicy: { maxAttempts: 3 },
};
