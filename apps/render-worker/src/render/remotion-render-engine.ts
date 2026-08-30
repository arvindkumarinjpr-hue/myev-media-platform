import { promises as fs } from "fs";
import { join, extname } from "path";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
// Static type imports — a missing dependency fails typecheck / build,
// never the first production render (correction §D). The heavy runtime
// machinery (esbuild for the bundler, Chrome Headless Shell for the
// renderer) is loaded via a literal-specifier dynamic import inside
// render() so it is not pulled in when RENDER_ENGINE=deterministic-test
// (tests) — this is deferred loading of a declared dependency, not a
// hidden import.
import type * as RemotionBundler from "@remotion/bundler";
import type * as RemotionRenderer from "@remotion/renderer";
import { resolveExportProfile, type VideoRenderInputV1 } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import type { RenderEngine, RenderEngineContext, RenderEngineResult } from "./render-engine.interface";

const COMPOSITION_ID = "MyevVideo";

/**
 * Module 7 Phase 7.5 — the PRODUCTION render engine (VIDEO_AUTOMATION_
 * ENGINE_V1.0.md §7: "FFmpeg pipeline / Remotion templates").
 * `RENDER_ENGINE=remotion` (the default for this worker).
 *
 * `@remotion/bundler` + `@remotion/renderer` are REAL, installed
 * dependencies of this package. Chromium (Chrome Headless Shell) is
 * ensured lazily via `ensureBrowser()` on the first render (pre-fetched
 * into the deployed image); FFmpeg is bundled inside `@remotion/renderer`
 * (no separate install).
 *
 * Materialized private input assets are copied into a per-job public
 * directory and referenced from the composition via `staticFile()` — no
 * arbitrary `file://` access, no client URL (checkpoint §28).
 */
@Injectable()
export class RemotionRenderEngine implements RenderEngine {
  readonly id = "remotion";
  private readonly logger = new Logger(RemotionRenderEngine.name);
  private readonly engineVersion: string;
  private readonly chromiumPath: string;
  private readonly entryOverride: string;
  private browserEnsured = false;

  constructor(config: ConfigService<WorkerConfig, true>) {
    const render = config.get("render", { infer: true });
    this.engineVersion = render.engineVersion;
    this.chromiumPath = render.chromiumExecutablePath;
    this.entryOverride = render.remotionEntry;
  }

  private entryPoint(): string {
    if (this.entryOverride) return this.entryOverride;
    // The composition sources ship beside this file in the deployed image
    // (see apps/render-worker/Dockerfile). `@remotion/bundler` compiles
    // TSX directly, so the raw source is the entry.
    return join(__dirname, "remotion", "index.tsx");
  }

  async render(input: VideoRenderInputV1, context: RenderEngineContext): Promise<RenderEngineResult> {
    const profile = resolveExportProfile(input.exportProfileId);
    const bundler: typeof RemotionBundler = await import("@remotion/bundler");
    const renderer: typeof RemotionRenderer = await import("@remotion/renderer");

    if (!this.browserEnsured) {
      await renderer.ensureBrowser(this.chromiumPath ? { browserExecutable: this.chromiumPath } : undefined);
      this.browserEnsured = true;
    }

    // Per-job public dir the composition's staticFile() references.
    const publicDir = join(context.workDir, "public");
    await fs.mkdir(publicDir, { recursive: true });
    const assetFiles: Record<string, string> = {};
    for (const asset of context.assets) {
      const ext = extname(asset.objectKey) || (asset.slot === "audio" ? ".mp3" : asset.slot === "subtitles" ? ".vtt" : ".bin");
      const fileName = `${asset.slot}${ext}`;
      await fs.copyFile(asset.localPath, join(publicDir, fileName));
      assetFiles[asset.slot] = fileName;
    }

    const entry = this.entryPoint();
    await fs.access(entry).catch(() => {
      throw new Error(`RENDER_ENGINE=remotion: composition entry not found at "${entry}" (set REMOTION_ENTRY or ship the composition sources)`);
    });

    const serveUrl = await bundler.bundle({ entryPoint: entry, publicDir, onProgress: () => undefined });

    const inputProps = { render: input, assetFiles };
    const composition = await renderer.selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });

    const outPath = join(context.workDir, "out.mp4");
    await renderer.renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      audioCodec: "aac",
      crf: profile.crf,
      outputLocation: outPath,
      inputProps,
      concurrency: 1,
      chromiumOptions: { gl: "swangle" },
      ...(this.chromiumPath ? { browserExecutable: this.chromiumPath } : {}),
      onProgress: () => undefined,
      logLevel: "error",
    });

    const videoBytes = await fs.readFile(outPath);
    this.logger.log(`remotion render complete (${videoBytes.length} bytes, ${input.width}x${input.height}, ${input.expectedDurationMs}ms, profile ${profile.id})`);
    return {
      videoBytes,
      mimeType: "video/mp4",
      container: "mp4",
      videoCodec: profile.videoCodec,
      audioCodec: profile.audioCodec,
      engine: this.id,
      engineVersion: this.engineVersion,
      brandingLayerRendered: input.branding.layerConfigured,
      brandingLogoRendered: !!input.branding.logoObjectKey,
      brandingIntroRendered: input.branding.introRequired,
      brandingOutroRendered: input.branding.outroRequired,
    };
  }
}
