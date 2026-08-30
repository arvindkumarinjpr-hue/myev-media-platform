import { EXPORT_PROFILES, resolveExportProfile, ExportProfileError } from "./export-profile";
import { VIDEO_TARGET_PLATFORMS } from "../agent-framework/agents/video-brief-agent";
import { deriveSceneTimeline, normalizeTransition } from "./scene-timeline";
import { buildDeterministicMp4, parseMp4 } from "./mp4";
import { validateVideoRenderInput, VIDEO_RENDER_INPUT_SCHEMA_VERSION } from "./video-render-input";
import { runVideoQa, type VideoQaInput } from "./video-qa";
import { MEDIA_VIDEO_RENDER_V1_MANIFEST } from "../queue/jobs/media-video-render";
import { validateProcessorManifest } from "../queue/processor-manifest";

const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

describe("export profiles", () => {
  it("has one profile per frozen target platform, id === platform", () => {
    for (const p of VIDEO_TARGET_PLATFORMS) {
      expect(EXPORT_PROFILES[p].id).toBe(p);
      expect(EXPORT_PROFILES[p].width).toBeGreaterThan(0);
      expect(EXPORT_PROFILES[p].height).toBeGreaterThan(0);
      expect(EXPORT_PROFILES[p].container).toBe("mp4");
    }
  });
  it("vertical formats are portrait, long/presentation landscape, square square", () => {
    expect(EXPORT_PROFILES.YOUTUBE_SHORTS.orientation).toBe("portrait");
    expect(EXPORT_PROFILES.INSTAGRAM_REEL.orientation).toBe("portrait");
    expect(EXPORT_PROFILES.YOUTUBE_LONG.orientation).toBe("landscape");
    expect(EXPORT_PROFILES.SQUARE_SOCIAL.orientation).toBe("square");
    expect(EXPORT_PROFILES.YOUTUBE_LONG.aspectRatio).toBe("16:9");
    expect(EXPORT_PROFILES.YOUTUBE_SHORTS.aspectRatio).toBe("9:16");
  });
  it("throws on an unknown platform", () => {
    expect(() => resolveExportProfile("TIKTOK")).toThrow(ExportProfileError);
  });
});

describe("deriveSceneTimeline", () => {
  const scenes = [
    { sceneId: "scene-1", order: 1, durationSeconds: 4, scriptSegmentRef: "seg-1", transition: "cut" },
    { sceneId: "scene-2", order: 2, durationSeconds: 6, scriptSegmentRef: "seg-2", transition: "fade" },
  ];
  const base = { scriptSegmentIds: ["seg-1", "seg-2"], currentSceneIds: ["scene-1", "scene-2"] };

  it("rescales to the narration audio and is contiguous", () => {
    const r = deriveSceneTimeline(scenes, { ...base, voiceDurationMs: 20_000 });
    expect(r.ok).toBe(true);
    expect(r.totalDurationMs).toBe(20_000);
    expect(r.timeline[0].startMs).toBe(0);
    expect(r.timeline[1].startMs).toBe(r.timeline[0].durationMs);
    expect(r.timeline[0].durationMs + r.timeline[1].durationMs).toBe(20_000);
  });
  it("rejects a scene referencing an unknown script segment", () => {
    const r = deriveSceneTimeline([{ ...scenes[0], scriptSegmentRef: "seg-99" }, scenes[1]], { ...base, voiceDurationMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/seg-99/);
  });
  it("rejects a stale plan whose scene set differs from current", () => {
    const r = deriveSceneTimeline(scenes, { ...base, currentSceneIds: ["scene-1"], voiceDurationMs: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/stale/);
  });
  it("rejects an unresolved scene when resolvedSceneIds is supplied", () => {
    const r = deriveSceneTimeline(scenes, { ...base, voiceDurationMs: 10_000, resolvedSceneIds: ["scene-1"] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/scene-2.*no resolved/);
  });
  it("rejects a non-positive scene duration", () => {
    const r = deriveSceneTimeline([{ ...scenes[0], durationSeconds: 0 }, scenes[1]], { ...base, voiceDurationMs: 10_000 });
    expect(r.ok).toBe(false);
  });
});

describe("normalizeTransition (checkpoint §M)", () => {
  it("passes fade/dissolve through and maps every other transition to cut", () => {
    expect(normalizeTransition("fade")).toBe("fade");
    expect(normalizeTransition("dissolve")).toBe("dissolve");
    expect(normalizeTransition("cut")).toBe("cut");
    expect(normalizeTransition("slide")).toBe("cut");
    expect(normalizeTransition("wipe")).toBe("cut");
    expect(normalizeTransition("zoom")).toBe("cut");
    expect(normalizeTransition("anything-unknown")).toBe("cut");
  });
});

describe("mp4 build + parse round-trip", () => {
  it("encodes the requested geometry and duration truthfully", () => {
    const buf = buildDeterministicMp4({ widthPx: 1080, heightPx: 1920, durationMs: 12_345, fps: 30, withAudioTrack: true });
    const info = parseMp4(buf);
    expect(info.ok).toBe(true);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.durationMs).toBe(12_345);
    expect(info.hasAudioTrack).toBe(true);
    expect(info.majorBrand).toBe("isom");
  });
  it("is byte-for-byte reproducible", () => {
    const a = buildDeterministicMp4({ widthPx: 1920, heightPx: 1080, durationMs: 8000, fps: 30 });
    const b = buildDeterministicMp4({ widthPx: 1920, heightPx: 1080, durationMs: 8000, fps: 30 });
    expect(a.equals(b)).toBe(true);
  });
  it("reports errors for a non-MP4 buffer", () => {
    const info = parseMp4(Buffer.from("not an mp4 file at all", "utf8"));
    expect(info.ok).toBe(false);
  });
  it("landscape file with no audio track reports hasAudioTrack false", () => {
    const info = parseMp4(buildDeterministicMp4({ widthPx: 1920, heightPx: 1080, durationMs: 5000, fps: 30 }));
    expect(info.hasAudioTrack).toBe(false);
  });
});

function validRenderInput() {
  return {
    schemaVersion: VIDEO_RENDER_INPUT_SCHEMA_VERSION,
    workspacePublicId: U(1),
    contentItemPublicId: U(2),
    targetPlatform: "YOUTUBE_LONG",
    exportProfileId: "YOUTUBE_LONG",
    width: 1920,
    height: 1080,
    fps: 30,
    expectedDurationMs: 10_000,
    scenes: [
      { order: 1, sceneId: "scene-1", scriptSegmentId: "seg-1", startMs: 0, durationMs: 4000, transition: "cut", asset: { assetGroupId: U(10), mediaAssetPublicId: U(11), assetType: "IMAGE", objectKey: "ws/1/img/a.png" } },
      { order: 2, sceneId: "scene-2", scriptSegmentId: "seg-2", startMs: 4000, durationMs: 6000, transition: "fade", asset: { assetGroupId: U(12), mediaAssetPublicId: U(13), assetType: "IMAGE", objectKey: "ws/1/img/b.png" } },
    ],
    audio: { audioAssetPublicId: U(20), objectKey: "ws/1/audio/n.mp3", durationMs: 10_000, scriptVersionHash: "abc123" },
    subtitles: { vttAssetPublicId: U(21), objectKey: "ws/1/sub/n.vtt", sourceAudioAssetPublicId: U(20), cueCount: 8 },
    branding: { layerConfigured: true, brandName: "MYEV", introRequired: false, outroRequired: false },
    correlationId: "corr-1",
  };
}

describe("validateVideoRenderInput", () => {
  it("accepts a well-formed snapshot", () => {
    expect(validateVideoRenderInput(validRenderInput())).toEqual({ ok: true, errors: [] });
  });
  it("rejects a non-contiguous timeline / wrong expectedDurationMs", () => {
    const r = validateVideoRenderInput({ ...validRenderInput(), expectedDurationMs: 9000 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/expectedDurationMs/);
  });
  it("rejects subtitle source audio mismatch", () => {
    const bad = validRenderInput();
    bad.subtitles.sourceAudioAssetPublicId = U(99);
    const r = validateVideoRenderInput(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/subtitle source audio/);
  });
  it("rejects a bad schema version", () => {
    expect(validateVideoRenderInput({ ...validRenderInput(), schemaVersion: 2 }).ok).toBe(false);
  });
});

describe("runVideoQa", () => {
  function qaInput(over: Partial<VideoQaInput> = {}): VideoQaInput {
    return {
      expectedWidth: 1920,
      expectedHeight: 1080,
      expectedProfileId: "YOUTUBE_LONG",
      expectedDurationMs: 10_000,
      output: { width: 1920, height: 1080, durationMs: 10_000, hasAudioTrack: true, byteLength: 5000, containerOk: true },
      snapshotScenes: [
        { sceneId: "scene-1", assetResolved: true, materialized: true },
        { sceneId: "scene-2", assetResolved: true, materialized: true },
      ],
      voice: { durationMs: 10_000, wordTimingCount: 40, audioAssetPublicId: U(20) },
      subtitles: { cues: [{ startMs: 0, endMs: 2000 }, { startMs: 2100, endMs: 4000 }], sourceAudioAssetPublicId: U(20) },
      branding: { layerConfigured: true, logoRequired: false, logoRendered: false, introRequired: false, introRendered: false, outroRequired: false, outroRendered: false },
      ...over,
    };
  }
  it("passes all six checks on a clean render", () => {
    const r = runVideoQa(qaInput());
    expect(r.passed).toBe(true);
    expect(r.checks.map((c) => c.id).sort()).toEqual(["audio_sync", "branding", "duration", "missing_assets", "resolution", "subtitle_sync"]);
  });
  it("fails resolution when the file geometry is wrong", () => {
    const r = runVideoQa(qaInput({ output: { width: 1280, height: 720, durationMs: 10_000, hasAudioTrack: true, byteLength: 1, containerOk: true } }));
    expect(r.passed).toBe(false);
    expect(r.checks.find((c) => c.id === "resolution")!.passed).toBe(false);
  });
  it("fails duration + audio_sync when the file is far too short", () => {
    const r = runVideoQa(qaInput({ output: { width: 1920, height: 1080, durationMs: 3000, hasAudioTrack: true, byteLength: 1, containerOk: true } }));
    expect(r.checks.find((c) => c.id === "duration")!.passed).toBe(false);
    expect(r.checks.find((c) => c.id === "audio_sync")!.passed).toBe(false);
  });
  it("fails missing_assets when a snapshot scene had no asset", () => {
    const r = runVideoQa(qaInput({ snapshotScenes: [{ sceneId: "scene-1", assetResolved: true, materialized: true }, { sceneId: "scene-2", assetResolved: false, materialized: false }] }));
    expect(r.checks.find((c) => c.id === "missing_assets")!.passed).toBe(false);
  });
  it("fails subtitle_sync when subtitles came from a different audio", () => {
    const r = runVideoQa(qaInput({ subtitles: { cues: [{ startMs: 0, endMs: 1000 }], sourceAudioAssetPublicId: U(77) } }));
    expect(r.checks.find((c) => c.id === "subtitle_sync")!.passed).toBe(false);
  });
  it("fails branding when an intro is required but not rendered", () => {
    const r = runVideoQa(qaInput({ branding: { layerConfigured: true, logoRequired: false, logoRendered: false, introRequired: true, introRendered: false, outroRequired: false, outroRendered: false } }));
    expect(r.checks.find((c) => c.id === "branding")!.passed).toBe(false);
  });
});

describe("MEDIA_VIDEO_RENDER_V1_MANIFEST", () => {
  it("is a well-formed manifest on the MEDIA queue", () => {
    expect(() => validateProcessorManifest(MEDIA_VIDEO_RENDER_V1_MANIFEST)).not.toThrow();
    expect(MEDIA_VIDEO_RENDER_V1_MANIFEST.jobType).toBe("media.video-render.v1");
    expect(MEDIA_VIDEO_RENDER_V1_MANIFEST.queue).toBe("MEDIA");
    expect(MEDIA_VIDEO_RENDER_V1_MANIFEST.timeout).toBe(45 * 60 * 1000);
  });
});
