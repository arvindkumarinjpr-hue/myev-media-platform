import type { VideoScenePlannerAgentOutput, VideoScriptAgentOutput } from "@myev/shared";
import { currentSceneIds, narrationText, scriptVersionHash } from "./video-media-hash";

const script: VideoScriptAgentOutput = {
  hook: "EVs are cheaper than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Cost", narration: "Running an EV in India costs about a third of petrol." } as never,
    { order: 2, id: "seg-2", label: "Charging", narration: "You can charge at home overnight." } as never,
  ],
  cta: "Subscribe for more.",
} as VideoScriptAgentOutput;

describe("video-media-hash", () => {
  it("scriptVersionHash is deterministic and changes when narration changes", () => {
    const a = scriptVersionHash(script);
    const b = scriptVersionHash({ ...script });
    expect(a).toEqual(b);
    const changed = scriptVersionHash({ ...script, segments: [{ ...script.segments[0], narration: "different" } as never, script.segments[1]] });
    expect(changed).not.toEqual(a);
  });

  it("scriptVersionHash is empty for a null script", () => {
    expect(scriptVersionHash(null)).toBe("");
  });

  it("narrationText joins hook + segments in order", () => {
    expect(narrationText(script)).toBe("EVs are cheaper than you think. Running an EV in India costs about a third of petrol. You can charge at home overnight.");
  });

  it("currentSceneIds returns scene ids sorted by order", () => {
    const plan = {
      scenePlanVersion: 1,
      targetPlatform: "YOUTUBE_LONG",
      scenes: [
        { order: 2, sceneId: "scene-2" },
        { order: 1, sceneId: "scene-1" },
      ],
    } as VideoScenePlannerAgentOutput;
    expect(currentSceneIds(plan)).toEqual(["scene-1", "scene-2"]);
    expect(currentSceneIds(null)).toEqual([]);
  });
});
