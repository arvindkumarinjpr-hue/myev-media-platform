import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ConfigService } from "@nestjs/config";
import { parseMp4, VIDEO_RENDER_INPUT_SCHEMA_VERSION, type VideoRenderInputV1 } from "@myev/shared";
import type { WorkerConfig } from "../src/config/configuration";
import { RemotionRenderEngine } from "../src/render/remotion-render-engine";
import type { MaterializedAsset } from "../src/render/render-engine.interface";

/**
 * Module 7 Phase 7.5 correction §F — the REAL Remotion production-runtime
 * smoke test. NOT the deterministic engine: this bundles the actual
 * composition, ensures a real headless browser, runs `renderMedia`
 * through the real Remotion + bundled FFmpeg, and inspects the produced
 * MP4.
 *
 * No external network, no OpenAI/Azure key, no DB/Redis/MinIO — a tiny
 * deterministic composition input (2 image scenes + a silent audio
 * track, ~0.8s, a low test resolution) so it stays CI-bounded. Runs in
 * the dedicated render-worker container in CI (which ships Chromium +
 * fonts); locally it needs a browser Remotion can find.
 */
const U = (n: number): string => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

// 1x1 opaque PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

function silentWav(seconds: number, sampleRate = 8000): Buffer {
  const samples = Math.round(seconds * sampleRate);
  const dataLen = samples * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);
  return buf;
}

function fakeConfig(workDir: string): ConfigService<WorkerConfig, true> {
  const render: WorkerConfig["render"] = {
    engine: "remotion",
    engineVersion: "smoke-test",
    tempDir: workDir,
    maxOutputBytes: 500 * 1024 * 1024,
    chromiumExecutablePath: process.env.RENDER_CHROMIUM_PATH ?? "",
    remotionEntry: process.env.REMOTION_ENTRY ?? "",
  };
  return { get: (key: string) => (key === "render" ? render : undefined) } as unknown as ConfigService<WorkerConfig, true>;
}

describe("Remotion production render — smoke", () => {
  jest.setTimeout(300_000);
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "myev-remotion-smoke-"));
  });
  afterAll(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("bundles the composition, renders a real MP4, and the output inspects correctly", async () => {
    const durationMs = 800;
    const width = 256;
    const height = 144;
    const fps = 10;

    const s1 = join(workDir, "s1.png");
    const s2 = join(workDir, "s2.png");
    const audio = join(workDir, "a.wav");
    writeFileSync(s1, PNG);
    writeFileSync(s2, PNG);
    writeFileSync(audio, silentWav(durationMs / 1000));

    const assets: MaterializedAsset[] = [
      { slot: "scene-1", objectKey: "smoke/s1.png", bytes: PNG, localPath: s1 },
      { slot: "scene-2", objectKey: "smoke/s2.png", bytes: PNG, localPath: s2 },
      { slot: "audio", objectKey: "smoke/a.wav", bytes: silentWav(durationMs / 1000), localPath: audio },
    ];

    const input: VideoRenderInputV1 = {
      schemaVersion: VIDEO_RENDER_INPUT_SCHEMA_VERSION,
      workspacePublicId: U(1),
      contentItemPublicId: U(2),
      targetPlatform: "YOUTUBE_LONG",
      exportProfileId: "YOUTUBE_LONG",
      width,
      height,
      fps,
      expectedDurationMs: durationMs,
      scenes: [
        { order: 1, sceneId: "scene-1", scriptSegmentId: "seg-1", startMs: 0, durationMs: 400, transition: "cut", asset: { assetGroupId: U(10), mediaAssetPublicId: U(11), assetType: "IMAGE", objectKey: "smoke/s1.png" } },
        { order: 2, sceneId: "scene-2", scriptSegmentId: "seg-2", startMs: 400, durationMs: 400, transition: "fade", asset: { assetGroupId: U(12), mediaAssetPublicId: U(13), assetType: "IMAGE", objectKey: "smoke/s2.png" } },
      ],
      audio: { audioAssetPublicId: U(20), objectKey: "smoke/a.wav", durationMs, scriptVersionHash: "smoke" },
      subtitles: { vttAssetPublicId: U(21), objectKey: "smoke/a.vtt", sourceAudioAssetPublicId: U(20), cueCount: 0 },
      branding: { layerConfigured: true, brandName: "MYEV", introRequired: false, outroRequired: false },
      correlationId: "smoke",
    };

    const engine = new RemotionRenderEngine(fakeConfig(workDir));
    const result = await engine.render(input, { workDir, assets });

    expect(result.engine).toBe("remotion");
    expect(result.container).toBe("mp4");
    expect(result.videoBytes.length).toBeGreaterThan(1000);

    const info = parseMp4(result.videoBytes);
    expect(info.ok).toBe(true);
    expect(info.majorBrand).toBeTruthy();
    expect(info.hasMoov).toBe(true);
    expect(info.width).toBe(width);
    expect(info.height).toBe(height);
    expect(info.durationMs).not.toBeNull();
    expect(Math.abs((info.durationMs as number) - durationMs)).toBeLessThanOrEqual(400);
    // Audio stream muxed in from the silent WAV.
    expect(info.hasAudioTrack).toBe(true);
  });
});
