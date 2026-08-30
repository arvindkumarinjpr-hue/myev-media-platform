import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, Equals, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Min, MinLength, ValidateNested, validateSync } from "class-validator";
import { VIDEO_TARGET_PLATFORMS } from "../agent-framework/agents/video-brief-agent";

/**
 * Module 7 Phase 7.5 — `VideoRenderInputV1`: the versioned, deterministic
 * contract between the pipeline's current artifacts (ScenePlan V1 +
 * resolved scene assets + approved Script + Voice audio + Subtitles +
 * branding + target/export profile) and the render engine's input props
 * (checkpoint §4).
 *
 * This is a FROZEN SNAPSHOT: once a render is submitted, this object is
 * persisted verbatim on the `VideoRenderJob` row and never mutated. The
 * renderer, Gate #4, and every QA check read from it — not from live
 * domain state — so a later upstream regeneration produces a
 * *different* snapshot for the next render rather than corrupting this
 * one (checkpoint §10/§24). No mutable domain objects are ever passed to
 * the renderer.
 */

export const VIDEO_RENDER_INPUT_SCHEMA_VERSION = 1 as const;

export class RenderAssetRef {
  /** The RESOLVED asset's version-chain root. */
  @IsUUID()
  assetGroupId!: string;

  /** The exact ACTIVE version frozen into this render. */
  @IsUUID()
  mediaAssetPublicId!: string;

  @IsIn(["IMAGE", "VIDEO"])
  assetType!: "IMAGE" | "VIDEO";

  /** Trusted internal object key — never a client URL (checkpoint §28). */
  @IsString()
  @MinLength(1)
  objectKey!: string;
}

export class RenderScene {
  @IsInt()
  @Min(1)
  order!: number;

  @Matches(/^scene-\d+$/)
  sceneId!: string;

  @IsString()
  @MinLength(1)
  scriptSegmentId!: string;

  @IsInt()
  @Min(0)
  startMs!: number;

  @IsInt()
  @Min(1)
  durationMs!: number;

  @IsIn(["cut", "fade", "dissolve", "slide", "wipe", "zoom"])
  transition!: string;

  @ValidateNested()
  @Type(() => RenderAssetRef)
  asset!: RenderAssetRef;
}

export class RenderAudioRef {
  @IsUUID()
  audioAssetPublicId!: string;

  @IsString()
  @MinLength(1)
  objectKey!: string;

  @IsInt()
  @Min(1)
  durationMs!: number;

  /** Fence: the script hash the narration was generated from (Gate #3). */
  @IsString()
  @MinLength(1)
  scriptVersionHash!: string;
}

export class RenderSubtitleRef {
  @IsUUID()
  vttAssetPublicId!: string;

  @IsString()
  @MinLength(1)
  objectKey!: string;

  @IsUUID()
  sourceAudioAssetPublicId!: string;

  @IsInt()
  @Min(0)
  cueCount!: number;
}

export class RenderBranding {
  @IsBoolean()
  layerConfigured!: boolean;

  @IsOptional()
  @IsString()
  brandName?: string;

  @IsOptional()
  @IsString()
  primaryColorHex?: string;

  /** Object key of a workspace-private brand logo asset, when one is configured. */
  @IsOptional()
  @IsString()
  logoObjectKey?: string;

  @IsBoolean()
  introRequired!: boolean;

  @IsBoolean()
  outroRequired!: boolean;
}

export class VideoRenderInputV1 {
  @IsInt()
  @Equals(VIDEO_RENDER_INPUT_SCHEMA_VERSION)
  schemaVersion!: number;

  @IsUUID()
  workspacePublicId!: string;

  @IsUUID()
  contentItemPublicId!: string;

  @IsIn(VIDEO_TARGET_PLATFORMS as unknown as string[])
  targetPlatform!: string;

  /** Equals the target platform in V1 — the authoritative export profile id. */
  @IsIn(VIDEO_TARGET_PLATFORMS as unknown as string[])
  exportProfileId!: string;

  @IsInt()
  @Min(1)
  width!: number;

  @IsInt()
  @Min(1)
  height!: number;

  @IsInt()
  @Min(1)
  fps!: number;

  /** Deterministic total from `deriveSceneTimeline` — the renderer's target length. */
  @IsInt()
  @Min(1)
  expectedDurationMs!: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RenderScene)
  scenes!: RenderScene[];

  @ValidateNested()
  @Type(() => RenderAudioRef)
  audio!: RenderAudioRef;

  @ValidateNested()
  @Type(() => RenderSubtitleRef)
  subtitles!: RenderSubtitleRef;

  @ValidateNested()
  @Type(() => RenderBranding)
  branding!: RenderBranding;

  /** Correlation id of the request that submitted the render. */
  @IsString()
  @MinLength(1)
  correlationId!: string;
}

export interface RenderInputValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Structural + cross-field validation the render submission runs BEFORE
 * enqueue and the render worker re-runs BEFORE rendering (checkpoint §4:
 * "validate before enqueue/render"). Beyond class-validator: the scene
 * timeline must be contiguous and its total must equal
 * `expectedDurationMs`; every scene must reference a real asset object
 * key; the subtitle source audio must equal the audio ref.
 */
export function validateVideoRenderInput(input: unknown): RenderInputValidationResult {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["render input is not an object"] };

  const instance = Object.assign(new VideoRenderInputV1(), input);
  // Rehydrate nested class instances for @ValidateNested.
  instance.scenes = (Array.isArray((input as VideoRenderInputV1).scenes) ? (input as VideoRenderInputV1).scenes : []).map((s) => {
    const rs = Object.assign(new RenderScene(), s);
    rs.asset = Object.assign(new RenderAssetRef(), (s as RenderScene)?.asset ?? {});
    return rs;
  });
  instance.audio = Object.assign(new RenderAudioRef(), (input as VideoRenderInputV1).audio ?? {});
  instance.subtitles = Object.assign(new RenderSubtitleRef(), (input as VideoRenderInputV1).subtitles ?? {});
  instance.branding = Object.assign(new RenderBranding(), (input as VideoRenderInputV1).branding ?? {});

  for (const e of validateSync(instance, { whitelist: false, forbidNonWhitelisted: false })) {
    errors.push(`${e.property}: ${Object.values(e.constraints ?? { _: "invalid" }).join(", ")}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const ordered = [...instance.scenes].sort((a, b) => a.order - b.order);
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    if (s.order !== i + 1) errors.push(`scene "${s.sceneId}" order ${s.order} is not contiguous (expected ${i + 1})`);
    if (s.startMs !== cursor) errors.push(`scene "${s.sceneId}" startMs ${s.startMs} is not contiguous with the prior scene (expected ${cursor})`);
    cursor += s.durationMs;
  }
  if (cursor !== instance.expectedDurationMs) {
    errors.push(`scene timeline total ${cursor}ms does not equal expectedDurationMs ${instance.expectedDurationMs}ms`);
  }
  if (instance.subtitles.sourceAudioAssetPublicId !== instance.audio.audioAssetPublicId) {
    errors.push("subtitle source audio does not match the render audio reference");
  }
  if (instance.exportProfileId !== instance.targetPlatform) {
    errors.push(`exportProfileId "${instance.exportProfileId}" must equal targetPlatform "${instance.targetPlatform}" in V1`);
  }
  if (instance.branding.layerConfigured && !instance.branding.logoObjectKey && !instance.branding.brandName) {
    errors.push("branding layer is configured but carries neither a logo nor a brand name");
  }

  return { ok: errors.length === 0, errors };
}
