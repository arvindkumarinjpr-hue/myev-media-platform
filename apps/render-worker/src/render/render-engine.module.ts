import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { WorkerConfig } from "../config/configuration";
import { RENDER_ENGINE, type RenderEngine } from "./render-engine.interface";
import { DeterministicTestRenderEngine } from "./deterministic-test-render-engine";
import { RemotionRenderEngine } from "./remotion-render-engine";

/**
 * Module 7 Phase 7.5 — binds the render engine by `RENDER_ENGINE` config.
 * Default is the deterministic test engine (no FFmpeg/Chromium) so every
 * automated test and CI run exercises the full render-job → MediaAsset →
 * Gate #4 → QA → Gate #5 chain without a browser (checkpoint §32).
 * `RENDER_ENGINE=remotion` selects the production engine on a deployed
 * render worker.
 */
@Global()
@Module({
  providers: [
    DeterministicTestRenderEngine,
    RemotionRenderEngine,
    {
      provide: RENDER_ENGINE,
      inject: [ConfigService, DeterministicTestRenderEngine, RemotionRenderEngine],
      useFactory: (config: ConfigService<WorkerConfig, true>, deterministic: DeterministicTestRenderEngine, remotion: RemotionRenderEngine): RenderEngine => {
        return config.get("render", { infer: true }).engine === "remotion" ? remotion : deterministic;
      },
    },
  ],
  exports: [RENDER_ENGINE],
})
export class RenderEngineModule {}
