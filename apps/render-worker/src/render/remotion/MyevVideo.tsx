/**
 * Module 7 Phase 7.5 — the single reusable Remotion composition
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md §7). One composition for every export
 * profile, driven entirely by a frozen `VideoRenderInputV1` +
 * `assetFiles` (the per-job public filenames the render engine copied
 * into the bundle's public dir). No per-platform duplicated engines
 * (checkpoint §7); no mutable domain object crosses the boundary.
 *
 * V1 scope (deliberately bounded — checkpoint §M): image scenes,
 * fade/dissolve transition dip, the narration audio track, and the
 * always-applied MYEV branding watermark layer. Burned-in captions and
 * distinct slide/wipe/zoom transitions are future work — the sidecar
 * VTT artifact is validated independently by QA Subtitle Sync.
 */
import React from "react";
import { AbsoluteFill, Audio, Img, interpolate, Sequence, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

export interface MyevRenderScene {
  order: number;
  sceneId: string;
  startMs: number;
  durationMs: number;
  transition: string;
}

export interface MyevVideoProps {
  render: {
    width: number;
    height: number;
    fps: number;
    expectedDurationMs: number;
    scenes: MyevRenderScene[];
    branding: { layerConfigured: boolean; brandName?: string };
  };
  /** slot ("scene-1", "audio", …) → filename inside the bundle public dir. */
  assetFiles: Record<string, string>;
}

const DIP_FRAMES = 8;

const SceneClip: React.FC<{ scene: MyevRenderScene; src: string }> = ({ scene, src }) => {
  const frame = useCurrentFrame();
  const dips = scene.transition === "fade" || scene.transition === "dissolve";
  const opacity = dips ? interpolate(frame, [0, DIP_FRAMES], [0, 1], { extrapolateRight: "clamp" }) : 1;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000", opacity }}>
      <Img src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </AbsoluteFill>
  );
};

export const MyevVideo: React.FC<MyevVideoProps> = ({ render, assetFiles }) => {
  const { fps } = useVideoConfig();
  const frames = (ms: number): number => Math.max(1, Math.round((ms / 1000) * fps));
  const brandName = render.branding.brandName ?? "MYEV";
  const audioFile = assetFiles.audio;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {[...render.scenes]
        .sort((a, b) => a.order - b.order)
        .map((scene) => {
          const file = assetFiles[scene.sceneId];
          if (!file) return null;
          return (
            <Sequence key={scene.sceneId} from={frames(scene.startMs)} durationInFrames={frames(scene.durationMs)}>
              <SceneClip scene={scene} src={staticFile(file)} />
            </Sequence>
          );
        })}

      {audioFile ? <Audio src={staticFile(audioFile)} /> : null}

      <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "flex-end", padding: Math.round(render.width * 0.03) }}>
        <div
          style={{
            color: "#ffffff",
            fontFamily: "Inter, Arial, Helvetica, sans-serif",
            fontWeight: 700,
            fontSize: Math.round(render.height * 0.028),
            opacity: 0.85,
            textShadow: "0 2px 8px rgba(0,0,0,0.6)",
          }}
        >
          {brandName}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
