import { promises as fs } from "fs";
import { join } from "path";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { resolveExportProfile, type VideoRenderInputV1 } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import type { RenderEngine, RenderEngineContext, RenderEngineResult } from "./render-engine.interface";

/**
 * Module 7 Phase 7.5 — the PRODUCTION render engine (VIDEO_AUTOMATION_
 * ENGINE_V1.0.md §7: "FFmpeg pipeline / Remotion templates"). Selected
 * with RENDER_ENGINE=remotion.
 *
 * The heavy dependencies (`@remotion/renderer`, `@remotion/bundler`,
 * `remotion`, `react`, `react-dom`) plus a system Chromium and FFmpeg
 * are DEPLOY-TIME requirements of the dedicated render worker only —
 * they are intentionally NOT in this phase's package.json / lockfile so
 * the general worker and CI never pull Chromium (checkpoint §1/§31,
 * documented in the Phase 7.5 report's Deployment section). They are
 * loaded lazily, by non-literal specifier, so this file type-checks and
 * the module graph resolves without them present; a misconfigured
 * deploy fails loudly here, not at import time.
 */
@Injectable()
export class RemotionRenderEngine implements RenderEngine {
  readonly id = "remotion";
  private readonly engineVersion: string;
  private readonly chromiumPath: string;

  private readonly entryPoint: string;

  constructor(config: ConfigService<WorkerConfig, true>) {
    const render = config.get("render", { infer: true });
    this.engineVersion = render.engineVersion;
    this.chromiumPath = render.chromiumExecutablePath;
    // The render-worker deploy image ships the composition sources and
    // sets REMOTION_ENTRY to their path; @remotion/bundler compiles TSX
    // directly.
    this.entryPoint = process.env.REMOTION_ENTRY ?? join(process.cwd(), "src", "render", "remotion", "index.tsx");
  }

  private async load<T = unknown>(specifier: string): Promise<T> {
    try {
      return (await import(specifier)) as T;
    } catch (err) {
      throw new Error(
        `RENDER_ENGINE=remotion requires "${specifier}" to be installed in the render worker (see the Phase 7.5 Deployment/Runtime section). Underlying error: ${(err as Error).message}`,
      );
    }
  }

  async render(input: VideoRenderInputV1, context: RenderEngineContext): Promise<RenderEngineResult> {
    const profile = resolveExportProfile(input.exportProfileId);
    const bundler = await this.load<{ bundle: (opts: unknown) => Promise<string> }>("@remotion/bundler");
    const renderer = await this.load<{
      selectComposition: (opts: unknown) => Promise<{ id: string; durationInFrames: number; fps: number; width: number; height: number }>;
      renderMedia: (opts: unknown) => Promise<unknown>;
    }>("@remotion/renderer");

    // The composition reads VideoRenderInputV1 straight from `inputProps`
    // (no mutable domain object crosses the boundary — checkpoint §7).
    const serveUrl = await bundler.bundle({ entryPoint: this.entryPoint, outDir: join(context.workDir, "bundle") });

    const inputProps = { render: input, assetDir: context.workDir };
    const composition = await renderer.selectComposition({ serveUrl, id: "MyevVideo", inputProps });

    const outPath = join(context.workDir, "out.mp4");
    await renderer.renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
      crf: profile.crf,
      audioCodec: "aac",
      ...(this.chromiumPath ? { browserExecutable: this.chromiumPath } : {}),
      chromiumOptions: { gl: "swangle" },
      concurrency: 1,
      signal: context.signal,
    });

    const videoBytes = await fs.readFile(outPath);
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
