/**
 * Module 7 Phase 7.5 — Remotion root. One registration serves every
 * export profile: width/height/fps/durationInFrames come from the frozen
 * VideoRenderInputV1 passed as inputProps via `calculateMetadata`.
 */
import React from "react";
import { Composition, registerRoot } from "remotion";
import { MyevVideo, type MyevVideoProps } from "./MyevVideo";

const DEFAULT_PROPS: MyevVideoProps = {
  render: { width: 1920, height: 1080, fps: 30, expectedDurationMs: 1000, scenes: [], branding: { layerConfigured: true, brandName: "MYEV" } },
  assetFiles: {},
};

// Remotion's <Composition> is generic over a zod schema; without one it
// wants Record<string, unknown> props. We validate the shape ourselves
// upstream (VideoRenderInputV1), so a narrow cast at the registration
// boundary is correct.
type LooseProps = Record<string, unknown>;
const CompositionAny = Composition as unknown as React.FC<{
  id: string;
  component: React.FC<LooseProps>;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  defaultProps: LooseProps;
  calculateMetadata: (opts: { props: LooseProps }) => { width: number; height: number; fps: number; durationInFrames: number };
}>;

const Root: React.FC = () => (
  <CompositionAny
    id="MyevVideo"
    component={MyevVideo as unknown as React.FC<LooseProps>}
    width={1920}
    height={1080}
    fps={30}
    durationInFrames={30}
    defaultProps={DEFAULT_PROPS as unknown as LooseProps}
    calculateMetadata={({ props }) => {
      const r = (props as unknown as MyevVideoProps).render;
      return {
        width: r.width,
        height: r.height,
        fps: r.fps,
        durationInFrames: Math.max(1, Math.round((r.expectedDurationMs / 1000) * r.fps)),
      };
    }}
  />
);

registerRoot(Root);
