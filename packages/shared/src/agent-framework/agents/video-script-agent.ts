import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsOptional, IsString, Matches, Min, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 7 Phase 7.2 — Video Script Agent
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md "2. Script Engine": long-form / Shorts
 * / Reel script, hook generation, CTA generation; FRD FR-VID-002).
 *
 * Input is the APPROVED brief. Output is a complete platform-aware
 * script: a hook, an ordered list of segments (each with a stable id, so
 * VIDEO_SCENE_PLANNER_AGENT_V1 can map every scene to a real segment —
 * FR-VID-003 AC), and a CTA. `postProcessOutput` renders the full
 * plain-text body and checks structural integrity.
 *
 * FR-VID-002 Business Rule: "Quality Gate #1 (Script Approved) must pass
 * before Scene Planning proceeds." That gate is Phase 7.2 pipeline
 * orchestration (VideoPipelineService), not enforced in this agent.
 */

/** Segment ids are `seg-1`, `seg-2`, … — stable, referenced by every scene. */
const SEGMENT_ID_PATTERN = /^seg-\d+$/;

export class VideoScriptSegment {
  @IsInt()
  @Min(1)
  order!: number;

  @Matches(SEGMENT_ID_PATTERN, { message: "segment id must be 'seg-<n>'" })
  id!: string;

  /** A short label — e.g. "Hook", "Problem", "Solution", "Proof", "CTA". */
  @IsString()
  @MinLength(1)
  label!: string;

  /** The spoken/narration text for this segment. */
  @IsString()
  @MinLength(1)
  narration!: string;

  /** What this segment is for — the scene planner uses it. */
  @IsString()
  @MinLength(1)
  purpose!: string;
}

export class VideoScriptAgentInput {
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
  @Min(5)
  durationSeconds!: number;

  @IsString()
  @MinLength(1)
  cta!: string;
}

export class VideoScriptAgentOutput {
  /** FR-VID-002 "hook" — the first 1–2 lines that stop the scroll. */
  @IsString()
  @MinLength(1)
  hook!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => VideoScriptSegment)
  segments!: VideoScriptSegment[];

  /** FR-VID-002 "CTA" — the closing call to action, as spoken. */
  @IsString()
  @MinLength(1)
  cta!: string;

  /** Optional: rendered full script body. When absent, `postProcessOutput`
   * fills it deterministically from hook + segments + cta. */
  @IsOptional()
  @IsString()
  scriptBody?: string;
}

/**
 * Deterministic structural checks + body rendering. Runs on the already
 * schema-validated output; throws (→ job fails safely) rather than
 * repairing a bad value.
 */
function postProcessOutput(output: VideoScriptAgentOutput): VideoScriptAgentOutput {
  const segments = [...output.segments].sort((a, b) => a.order - b.order);
  const orders = segments.map((s) => s.order);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      throw new Error(`video script segments must have a contiguous 1..${segments.length} order; got [${orders.join(", ")}]`);
    }
  }
  const ids = new Set<string>();
  for (const s of segments) {
    if (ids.has(s.id)) throw new Error(`duplicate script segment id "${s.id}"`);
    ids.add(s.id);
    if (s.id !== `seg-${s.order}`) throw new Error(`script segment id "${s.id}" does not match its order ${s.order} (expected "seg-${s.order}")`);
  }

  const body =
    output.scriptBody && output.scriptBody.trim().length > 0
      ? output.scriptBody
      : [`HOOK: ${output.hook}`, "", ...segments.flatMap((s) => [`[${s.id}] ${s.label}`, s.narration, ""]), `CTA: ${output.cta}`].join("\n");

  return { hook: output.hook, segments, cta: output.cta, scriptBody: body };
}

function buildPrompt(input: VideoScriptAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const brand = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";
  const isShort = ["YOUTUBE_SHORTS", "INSTAGRAM_REEL", "FACEBOOK_REEL"].includes(input.targetPlatform);

  const systemInstructions = [
    "You are the Video Script Agent for an EV (electric vehicle) content platform.",
    "Given an approved video brief, write a complete narration script: a scroll-stopping hook, an ordered list of segments, and a spoken call-to-action.",
    isShort
      ? "This is a SHORT vertical video. Keep it punchy: a hard hook in the first 3 seconds, 3–5 short segments, one clear CTA. Total narration should fit the target duration when read aloud at a natural pace."
      : "This is a long-form landscape video. Use a strong hook, then a logical arc of segments (context → detail → proof → next step), and a clear CTA. Pace the narration to roughly fill the target duration when read aloud.",
    "Each segment needs a stable id ('seg-1', 'seg-2', …), a short label, the narration text, and a one-line purpose. A later agent maps visual scenes onto these segments, so every segment must be a self-contained beat.",
    "Do not invent statistics, prices, quotes, or product claims. Do not include visual directions or shot lists — that is the scene planner's job.",
    brand ? `BRAND GUIDELINES (tone, terminology, CTA rules): ${brand}` : "",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Target platform: ${input.targetPlatform}`,
    `Objective: ${input.objective}`,
    `Audience: ${input.audience}`,
    `Target duration (seconds): ${input.durationSeconds}`,
    `Desired CTA: ${input.cta}`,
    "",
    'Respond with a single JSON object matching VideoScriptAgentOutput exactly: hook, segments (array of { order, id: "seg-<n>", label, narration, purpose }), cta.',
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const VIDEO_SCRIPT_AGENT_V1: AgentDefinition<VideoScriptAgentInput, VideoScriptAgentOutput> = {
  identifier: "video-script-agent",
  version: 1,
  purpose: "Generates a complete platform-aware video narration script (hook, ordered segments with stable ids, CTA) from an approved video brief — FR-VID-002.",
  type: "content-generation",
  requiredKnowledgePackCapability: "brand_guidelines",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: VideoScriptAgentInput,
  outputSchema: VideoScriptAgentOutput,
  buildPrompt,
  postProcessOutput,
  // No frozen FRD §21.1 figure for video script generation. Comparable in
  // length to the Blog draft (frozen 5 min) but not itself frozen — a
  // documented implementation default of 4 min, still with real headroom
  // under the 360s ai.execute.v1 manifest ceiling.
  timeoutMs: 240_000,
  executionPolicy: { maxAttempts: 3 },
};
