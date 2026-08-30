import type { VideoRenderInputV1 } from "@myev/shared";

/**
 * Module 7 Phase 7.5 — the render engine abstraction. The render
 * processor depends only on this; the concrete engine (deterministic
 * test vs Remotion/FFmpeg) is chosen by `RENDER_ENGINE` config so
 * automated tests never require a browser or FFmpeg (checkpoint §32).
 */

export interface MaterializedAsset {
  /** The scene id / "audio" / "subtitles" this asset belongs to. */
  readonly slot: string;
  readonly objectKey: string;
  readonly bytes: Buffer;
  readonly localPath: string;
}

export interface RenderEngineContext {
  /** Per-job isolated working directory — cleaned by the processor on every exit. */
  readonly workDir: string;
  /** Every input asset already fetched from trusted internal storage into `workDir`. */
  readonly assets: readonly MaterializedAsset[];
  readonly signal?: AbortSignal;
}

export interface RenderEngineResult {
  readonly videoBytes: Buffer;
  readonly mimeType: "video/mp4";
  readonly container: "mp4";
  readonly videoCodec: string;
  readonly audioCodec: string;
  readonly engine: string;
  readonly engineVersion: string;
  /** Deterministic branding evidence for QA (checkpoint §21). */
  readonly brandingLayerRendered: boolean;
  readonly brandingLogoRendered: boolean;
  readonly brandingIntroRendered: boolean;
  readonly brandingOutroRendered: boolean;
}

export interface RenderEngine {
  readonly id: string;
  render(input: VideoRenderInputV1, context: RenderEngineContext): Promise<RenderEngineResult>;
}

export const RENDER_ENGINE = Symbol("RENDER_ENGINE");
