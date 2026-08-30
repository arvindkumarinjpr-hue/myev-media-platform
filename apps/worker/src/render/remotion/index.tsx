/* eslint-disable */
// @ts-nocheck
/**
 * Module 7 Phase 7.5 — Remotion root. DEPLOY-ONLY (see MyevVideo.tsx).
 * The composition's width/height/fps/durationInFrames come from the
 * frozen VideoRenderInputV1 passed as inputProps, so a single
 * registration serves every export profile.
 */
import React from "react";
import { Composition, registerRoot } from "remotion";
import { MyevVideo } from "./MyevVideo";

const Root: React.FC = () => {
  return (
    <Composition
      id="MyevVideo"
      component={MyevVideo as any}
      width={1920}
      height={1080}
      fps={30}
      durationInFrames={30}
      defaultProps={{ render: null as any, assetDir: "" }}
      calculateMetadata={({ props }: any) => {
        const r = props.render;
        return {
          width: r.width,
          height: r.height,
          fps: r.fps,
          durationInFrames: Math.max(1, Math.round((r.expectedDurationMs / 1000) * r.fps)),
        };
      }}
    />
  );
};

registerRoot(Root);
