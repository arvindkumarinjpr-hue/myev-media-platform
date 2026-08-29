import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsString, Matches, Min, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";
import { VIDEO_SCENE_PLAN_SCHEMA_VERSION, VideoScenePlanV1, validateVideoScenePlan } from "./video-scene-plan";

/**
 * Module 7 Phase 7.2 — Video Scene Planner Agent
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md "3. Scene Planner": scene timeline,
 * visual instructions, B-roll suggestions, transition plan; FRD
 * FR-VID-003).
 *
 * Input is the APPROVED script (its stable segment ids + narration) plus
 * the target platform. Output is a `VideoScenePlanV1` — the versioned D8
 * contract (see video-scene-plan.ts). `postProcessOutput` runs the
 * cross-field structural validation (`validateVideoScenePlan`) against
 * the segment ids the agent was given; the pipeline re-validates against
 * the authoritative approved-script segments before persisting.
 *
 * FR-VID-003 Dependency: "FR-VID-002 (Quality Gate #1)" — Scene Planning
 * requires an APPROVED script. That gate is Phase 7.2 pipeline
 * orchestration, not enforced in this agent.
 */

export class ScenePlannerScriptSegment {
  @Matches(/^seg-\d+$/, { message: "segment id must be 'seg-<n>'" })
  id!: string;

  @IsInt()
  @Min(1)
  order!: number;

  @IsString()
  @MinLength(1)
  label!: string;

  @IsString()
  @MinLength(1)
  narration!: string;

  @IsString()
  @MinLength(1)
  purpose!: string;
}

export class VideoScenePlannerAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  @IsString()
  @MinLength(1)
  targetPlatform!: string;

  @IsInt()
  @Min(5)
  durationSeconds!: number;

  @IsString()
  @MinLength(1)
  hook!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ValidateNested({ each: true })
  @Type(() => ScenePlannerScriptSegment)
  segments!: ScenePlannerScriptSegment[];
}

/**
 * The Scene Planner's output IS a VideoScenePlanV1 (the D8 contract).
 * Re-exported name kept explicit so the pipeline / read model refer to
 * one type.
 */
export class VideoScenePlannerAgentOutput extends VideoScenePlanV1 {}

function postProcessOutput(output: VideoScenePlannerAgentOutput, input: VideoScenePlannerAgentInput): VideoScenePlannerAgentOutput {
  const result = validateVideoScenePlan(output, { scriptSegmentIds: input.segments.map((s) => s.id) });
  if (!result.ok) {
    throw new Error(`scene plan failed structural validation: ${result.errors.join("; ")}`);
  }
  return output;
}

function buildPrompt(input: VideoScenePlannerAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const brand = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";
  const segments = input.segments.map((s) => `- ${s.id} (${s.label}): ${s.narration}`).join("\n");

  const systemInstructions = [
    "You are the Video Scene Planner Agent for an EV (electric vehicle) content platform.",
    "Given an approved narration script (a hook + ordered segments), produce a scene-by-scene visual plan for the video.",
    "Rules:",
    `- Output "scenePlanVersion": ${VIDEO_SCENE_PLAN_SCHEMA_VERSION} exactly.`,
    "- Produce one or more scenes. Every scene must reference exactly one script segment id via \"scriptSegmentRef\", and EVERY script segment must be covered by at least one scene.",
    "- Number scenes with a contiguous 1-based \"order\"; give each a \"sceneId\" of \"scene-<order>\".",
    "- \"startSeconds\" is the absolute offset on the final timeline and must be non-decreasing; \"durationSeconds\" is that scene's length. Total should be close to the target duration.",
    "- \"transition\" is one of: cut, fade, dissolve, slide, wipe, zoom. Scene 1 is usually \"cut\".",
    "- Each scene needs a \"visualInstruction\" (framing / on-screen direction), an optional \"bRollSuggestion\", and one or more \"assetRequirements\" (each { kind, description, sourceHint }).",
    "- kind is one of: image, video_clip, b_roll, icon, text_overlay, background. sourceHint is one of: ai_generated, stock, brand_library, screen_recording, unspecified.",
    "Do not invent stock-footage URLs or specific asset filenames — describe what is needed.",
    brand ? `BRAND GUIDELINES: ${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Target platform: ${input.targetPlatform}`,
    `Target duration (seconds): ${input.durationSeconds}`,
    `Hook: ${input.hook}`,
    "Script segments:",
    segments,
    "",
    'Respond with a single JSON object matching VideoScenePlanV1 exactly: scenePlanVersion, targetPlatform, scenes (array of { order, sceneId, scriptSegmentRef, startSeconds, durationSeconds, visualInstruction, bRollSuggestion?, transition, assetRequirements: [{ kind, description, sourceHint }] }).',
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const VIDEO_SCENE_PLANNER_AGENT_V1: AgentDefinition<VideoScenePlannerAgentInput, VideoScenePlannerAgentOutput> = {
  identifier: "video-scene-planner-agent",
  version: 1,
  purpose: "Produces a versioned VideoScenePlanV1 (ordered scenes, script-segment mapping, visual instructions, B-roll, transitions, asset requirements) from an approved video script — FR-VID-003 / checkpoint D8.",
  type: "content-generation",
  requiredKnowledgePackCapability: "brand_guidelines",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: VideoScenePlannerAgentInput,
  outputSchema: VideoScenePlannerAgentOutput,
  buildPrompt,
  postProcessOutput,
  // No frozen FRD §21.1 figure — documented implementation default (3 min),
  // under the 360s ai.execute.v1 manifest ceiling.
  timeoutMs: 180_000,
  executionPolicy: { maxAttempts: 3 },
};
