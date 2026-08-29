import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, Equals, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Min, MinLength, ValidateNested } from "class-validator";

/**
 * Module 7 Phase 7.2 — the VERSIONED, validated Scene Plan contract
 * (architecture-checkpoint decision D8, resolved here).
 *
 * This is the canonical boundary between VIDEO_SCENE_PLANNER_AGENT_V1's
 * output and every later phase that consumes a scene plan:
 *   - Phase 7.4 asset collection (per-scene `assetRequirements`)
 *   - Phase 7.4 voice / subtitle timing (`startSeconds` / `durationSeconds`)
 *   - Phase 7.5 Remotion render input props
 *
 * Deliberately NOT arbitrary JSON: the Scene Planner agent uses
 * `VideoScenePlanV1` as its `outputSchema`, so a malformed plan fails
 * class-validator before the job can COMPLETE; the pipeline additionally
 * calls `validateVideoScenePlan()` (below) against the *approved* script's
 * real segment ids before persisting the plan onto
 * `video_scripts.scene_plan`.
 *
 * Phase 7.5 must be able to transform this deterministically into
 * versioned Remotion input props WITHOUT redesigning the agent output —
 * hence: an explicit `scenePlanVersion`, a stable per-scene `sceneId`, a
 * contiguous 1-based `order`, an absolute `startSeconds` timeline, and a
 * closed `transition` vocabulary.
 */

export const VIDEO_SCENE_PLAN_SCHEMA_VERSION = 1 as const;

/** Closed transition vocabulary — Phase 7.5 maps each to a Remotion transition primitive. */
export const SCENE_TRANSITIONS = ["cut", "fade", "dissolve", "slide", "wipe", "zoom"] as const;
export type SceneTransition = (typeof SCENE_TRANSITIONS)[number];

/** What a scene needs sourced (Phase 7.4 Asset Manager resolves each against uploaded / AI-generated assets). */
export const SCENE_ASSET_KINDS = ["image", "video_clip", "b_roll", "icon", "text_overlay", "background"] as const;
export type SceneAssetKind = (typeof SCENE_ASSET_KINDS)[number];

/** Advisory sourcing hint — never authoritative; Phase 7.4 owns real resolution. */
export const SCENE_ASSET_SOURCE_HINTS = ["ai_generated", "stock", "brand_library", "screen_recording", "unspecified"] as const;
export type SceneAssetSourceHint = (typeof SCENE_ASSET_SOURCE_HINTS)[number];

export class VideoSceneAssetRequirement {
  @IsIn(SCENE_ASSET_KINDS)
  kind!: SceneAssetKind;

  @IsString()
  @MinLength(1)
  description!: string;

  @IsIn(SCENE_ASSET_SOURCE_HINTS)
  sourceHint!: SceneAssetSourceHint;
}

export class VideoScene {
  /** 1-based position on the timeline. The plan's scenes must be a
   * contiguous 1..N with no gaps or duplicates (enforced by
   * `validateVideoScenePlan`). */
  @IsInt()
  @Min(1)
  order!: number;

  /** Stable identifier — `scene-1`, `scene-2`, … . Never reused across a
   * regenerated plan for a different scene. */
  @Matches(/^scene-\d+$/, { message: "sceneId must be 'scene-<n>'" })
  sceneId!: string;

  /** The `id` of the approved script segment this scene renders. Every
   * scene MUST map to a real segment (FR-VID-003 AC). */
  @IsString()
  @MinLength(1)
  scriptSegmentRef!: string;

  /** Absolute start offset (seconds) on the final video timeline. */
  @IsNumber()
  @Min(0)
  startSeconds!: number;

  @IsNumber()
  @Min(0.1)
  durationSeconds!: number;

  /** Camera / framing / on-screen direction for this scene. */
  @IsString()
  @MinLength(1)
  visualInstruction!: string;

  /** Optional B-roll idea (VIDEO_AUTOMATION_ENGINE "Scene Planner → B-roll suggestions"). */
  @IsOptional()
  @IsString()
  bRollSuggestion?: string;

  /** Transition INTO this scene from the previous one. Scene 1's is
   * typically "cut". */
  @IsIn(SCENE_TRANSITIONS)
  transition!: SceneTransition;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VideoSceneAssetRequirement)
  assetRequirements!: VideoSceneAssetRequirement[];
}

export class VideoScenePlanV1 {
  @IsInt()
  @Equals(VIDEO_SCENE_PLAN_SCHEMA_VERSION, { message: `scenePlanVersion must be ${VIDEO_SCENE_PLAN_SCHEMA_VERSION}` })
  scenePlanVersion!: number;

  /** Echoed from the brief/script — the render export profile is derived
   * from this in Phase 7.5. */
  @IsString()
  @MinLength(1)
  targetPlatform!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => VideoScene)
  scenes!: VideoScene[];
}

export interface ScenePlanValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Cross-field structural checks class-validator decorators can't express.
 * Called both as the agent's `postProcessOutput` hook (with the segment
 * ids the agent was given as input) and by the pipeline before persisting
 * (with the authoritative approved-script segment ids). Pure — no I/O.
 *
 * Rules:
 *  1. `order` is a contiguous 1..N with no gaps or duplicates.
 *  2. `sceneId` values are unique and match their `order` (`scene-<order>`).
 *  3. `startSeconds` is non-decreasing across scenes in `order`.
 *  4. every `scriptSegmentRef` is one of `scriptSegmentIds` (each scene
 *     maps to a real script segment — FR-VID-003).
 *  5. every script segment is covered by at least one scene (no dropped
 *     narration).
 */
export function validateVideoScenePlan(plan: VideoScenePlanV1, opts: { scriptSegmentIds: string[] }): ScenePlanValidationResult {
  const errors: string[] = [];
  const scenes = [...plan.scenes].sort((a, b) => a.order - b.order);

  const orders = scenes.map((s) => s.order);
  for (let i = 0; i < orders.length; i++) {
    if (orders[i] !== i + 1) {
      errors.push(`scene order must be a contiguous 1..${scenes.length}; got [${orders.join(", ")}]`);
      break;
    }
  }

  const sceneIds = new Set<string>();
  for (const s of scenes) {
    if (sceneIds.has(s.sceneId)) errors.push(`duplicate sceneId "${s.sceneId}"`);
    sceneIds.add(s.sceneId);
    if (s.sceneId !== `scene-${s.order}`) errors.push(`sceneId "${s.sceneId}" does not match its order ${s.order} (expected "scene-${s.order}")`);
  }

  for (let i = 1; i < scenes.length; i++) {
    if (scenes[i].startSeconds < scenes[i - 1].startSeconds) {
      errors.push(`startSeconds must be non-decreasing across scenes (scene-${scenes[i].order} starts before scene-${scenes[i - 1].order})`);
    }
  }

  const known = new Set(opts.scriptSegmentIds);
  for (const s of scenes) {
    if (!known.has(s.scriptSegmentRef)) {
      errors.push(`scene-${s.order} references unknown script segment "${s.scriptSegmentRef}"`);
    }
  }
  const covered = new Set(scenes.map((s) => s.scriptSegmentRef));
  for (const segId of opts.scriptSegmentIds) {
    if (!covered.has(segId)) errors.push(`script segment "${segId}" is not covered by any scene`);
  }

  return { ok: errors.length === 0, errors };
}
