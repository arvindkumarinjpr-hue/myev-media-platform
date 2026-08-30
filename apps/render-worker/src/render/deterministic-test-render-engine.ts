import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { buildDeterministicMp4, type VideoRenderInputV1 } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import type { RenderEngine, RenderEngineContext, RenderEngineResult } from "./render-engine.interface";

/**
 * Module 7 Phase 7.5 — the deterministic test render engine
 * (checkpoint §32). Produces a byte-reproducible, structurally valid
 * MP4 whose `moov` truthfully encodes the export profile's geometry,
 * the deterministic timeline duration, and the profile fps — WITHOUT
 * FFmpeg, Chromium, or Remotion. It still exercises the whole render
 * chain: every input asset is materialized and read (proving the
 * private-asset fetch path), the produced file passes real MP4
 * inspection, a genuine checksum is computed, and a real ACTIVE VIDEO
 * MediaAsset is persisted.
 *
 * It does NOT paint pixels — it is a render *stand-in* for CI, not a
 * player-ready file. The production path is `RemotionRenderEngine`
 * (RENDER_ENGINE=remotion).
 */
@Injectable()
export class DeterministicTestRenderEngine implements RenderEngine {
  readonly id = "deterministic-test";
  private readonly engineVersion: string;

  constructor(config: ConfigService<WorkerConfig, true>) {
    this.engineVersion = config.get("render", { infer: true }).engineVersion;
  }

  async render(input: VideoRenderInputV1, context: RenderEngineContext): Promise<RenderEngineResult> {
    // Prove every declared input asset materialized and is non-empty —
    // this is what QA "Missing Assets" (checkpoint §16) verifies against.
    const slots = new Set(context.assets.map((a) => a.slot));
    for (const scene of input.scenes) {
      if (!slots.has(scene.sceneId)) throw new Error(`render: scene "${scene.sceneId}" asset was not materialized`);
    }
    if (!slots.has("audio")) throw new Error("render: narration audio was not materialized");
    if (!slots.has("subtitles")) throw new Error("render: subtitle track was not materialized");
    for (const a of context.assets) {
      if (a.bytes.length === 0) throw new Error(`render: materialized asset for "${a.slot}" is empty`);
    }
    if (context.signal?.aborted) throw new Error("render: aborted before encode");

    const videoBytes = buildDeterministicMp4({
      widthPx: input.width,
      heightPx: input.height,
      durationMs: input.expectedDurationMs,
      fps: input.fps,
      withAudioTrack: true,
    });

    return {
      videoBytes,
      mimeType: "video/mp4",
      container: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      engine: this.id,
      engineVersion: this.engineVersion,
      brandingLayerRendered: input.branding.layerConfigured,
      brandingLogoRendered: !!input.branding.logoObjectKey,
      brandingIntroRendered: input.branding.introRequired,
      brandingOutroRendered: input.branding.outroRequired,
    };
  }
}
