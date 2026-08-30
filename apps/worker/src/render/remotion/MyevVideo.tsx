/* eslint-disable */
// @ts-nocheck
/**
 * Module 7 Phase 7.5 — the single reusable Remotion composition
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md §7). One composition, driven entirely
 * by a frozen `VideoRenderInputV1` + the resolved `ExportProfile` — no
 * per-platform duplicated engines (checkpoint §7).
 *
 * DEPLOY-ONLY: this file imports `remotion` / `react`, which are NOT
 * installed in this phase's lockfile (see remotion-render-engine.ts and
 * the Phase 7.5 Deployment section). It is excluded from the worker's
 * `tsc` build and bundled directly from source by `@remotion/bundler`
 * on a render-worker deploy. It is intentionally not covered by the CI
 * test matrix; the deterministic engine backs every automated test.
 */
import React from "react";
import { AbsoluteFill, Audio, Img, Sequence, staticFile, useVideoConfig } from "remotion";

const TRANSITION_FADE_FRAMES = 8;

export const MyevVideo: React.FC<{ render: any; assetDir: string }> = ({ render }) => {
  const { fps } = useVideoConfig();
  const ms = (v: number) => Math.round((v / 1000) * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {render.scenes.map((scene: any) => (
        <Sequence key={scene.sceneId} from={ms(scene.startMs)} durationInFrames={Math.max(1, ms(scene.durationMs))}>
          <AbsoluteFill>
            <Img src={staticFile(basename(scene.asset.objectKey))} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </AbsoluteFill>
          {scene.transition === "fade" || scene.transition === "dissolve" ? (
            <AbsoluteFill style={{ backgroundColor: "#000", opacity: fadeOpacity() }} />
          ) : null}
        </Sequence>
      ))}

      <Audio src={staticFile(basename(render.audio.objectKey))} />

      {/* Branding watermark layer — always applied in V1 (checkpoint §21). */}
      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-end", padding: 32 }}>
        <div style={{ color: "#fff", fontFamily: "Inter, Arial, sans-serif", fontWeight: 700, fontSize: 28, opacity: 0.85 }}>
          {render.branding.brandName ?? "MYEV"}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

function basename(key: string): string {
  const parts = key.split("/");
  return parts[parts.length - 1];
}
function fadeOpacity(): number {
  return 0;
}
void TRANSITION_FADE_FRAMES;
