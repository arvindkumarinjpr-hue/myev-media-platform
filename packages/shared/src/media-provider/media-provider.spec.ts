import { ImageGenerationProviderRegistryBuilder, MediaProviderRegistryValidationError } from "./image-generation-provider-registry";
import { TtsProviderRegistryBuilder } from "./tts-provider-registry";
import { MediaProviderError, MediaProviderErrorCode } from "./media-provider-error";
import { FakeImageProvider } from "./providers/fake-image-provider";
import { FakeTtsProvider } from "./providers/fake-tts-provider";
import { verifyMediaBytes } from "./media-bytes-verify";
import { validateWordTimings } from "./word-timing";

const req = { workspaceId: "w1", correlationId: "c1" };

describe("media provider registries", () => {
  it("image registry: register → freeze → resolve; rejects duplicates and post-freeze registration", () => {
    const b = new ImageGenerationProviderRegistryBuilder();
    b.register(new FakeImageProvider("success", 1, "a"));
    expect(() => b.register(new FakeImageProvider("success", 1, "a"))).toThrow(MediaProviderRegistryValidationError);
    b.register(new FakeImageProvider("success", 1, "b"));
    const reg = b.freeze();
    expect(reg.has("a")).toBe(true);
    expect(reg.resolve("b").id).toBe("b");
    expect(() => reg.resolve("nope")).toThrow(/unknown image provider/);
    expect(() => b.register(new FakeImageProvider("success", 1, "c"))).toThrow(/already frozen/);
  });

  it("tts registry: same accumulate-then-freeze discipline", () => {
    const b = new TtsProviderRegistryBuilder();
    b.register(new FakeTtsProvider("success", 1, "x"));
    const reg = b.freeze();
    expect(reg.list().map((p) => p.id)).toEqual(["x"]);
    expect(() => reg.resolve("y")).toThrow(/unknown TTS provider/);
  });
});

describe("FakeImageProvider", () => {
  it("returns a real PNG that passes magic-byte verification, sized to the aspect ratio", async () => {
    const r = await new FakeImageProvider("success").generate({ ...req, prompt: "p", aspectRatio: "9:16" });
    expect(verifyMediaBytes(r.imageBytes, "IMAGE", r.mimeType)).toBe("image/png");
    expect(r.height).toBeGreaterThan(r.width);
    expect(r.usage?.imageCount).toBe(1);
  });

  it.each([
    ["transient_error", true],
    ["permanent_error", false],
    ["moderation", false],
    ["rate_limit", true],
    ["timeout", true],
  ] as const)("mode %s maps to a %s retryable MediaProviderError", async (mode, retryable) => {
    await expect(new FakeImageProvider(mode).generate({ ...req, prompt: "p", aspectRatio: "16:9" })).rejects.toMatchObject({ retryable });
  });

  it("flaky_then_success fails then succeeds on the same instance", async () => {
    const p = new FakeImageProvider("flaky_then_success", 1);
    await expect(p.generate({ ...req, prompt: "p", aspectRatio: "16:9" })).rejects.toBeInstanceOf(MediaProviderError);
    const ok = await p.generate({ ...req, prompt: "p", aspectRatio: "16:9" });
    expect(ok.provider).toBe("fake-image");
  });
});

describe("FakeTtsProvider", () => {
  it("returns audio + a valid word-timing stream aligned to the text", async () => {
    const r = await new FakeTtsProvider("success").synthesize({ ...req, text: "one two three", voiceProfileId: "v", providerVoiceId: "pv", language: "en-IN", outputFormat: "wav" });
    expect(verifyMediaBytes(r.audioBytes, "AUDIO", r.mimeType)).toBe("audio/wav");
    expect(r.wordTimings).toHaveLength(3);
    expect(() => validateWordTimings(r.wordTimings!)).not.toThrow();
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it("success_no_timings returns audio with NO word timings (for the processor's guard)", async () => {
    const r = await new FakeTtsProvider("success_no_timings").synthesize({ ...req, text: "hi", voiceProfileId: "v", providerVoiceId: "pv", language: "en-IN", outputFormat: "mp3" });
    expect(r.wordTimings).toBeUndefined();
  });

  it("moderation is a permanent CONTENT_MODERATION error", async () => {
    await expect(new FakeTtsProvider("moderation").synthesize({ ...req, text: "x", voiceProfileId: "v", providerVoiceId: "pv", language: "en-IN", outputFormat: "mp3" })).rejects.toMatchObject({
      code: MediaProviderErrorCode.CONTENT_MODERATION,
      retryable: false,
    });
  });
});

describe("verifyMediaBytes", () => {
  it("rejects an executable disguised as an image", () => {
    expect(verifyMediaBytes(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "IMAGE", "image/png")).toBeNull();
  });
  it("verifies a WEBVTT document only when declared as text/vtt", () => {
    const vtt = Buffer.from("WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n", "utf8");
    expect(verifyMediaBytes(vtt, "SUBTITLE", "text/vtt")).toBe("text/vtt");
    expect(verifyMediaBytes(vtt, "SUBTITLE", "application/x-subrip")).toBeNull();
  });
  it("rejects subtitle bytes containing NUL", () => {
    expect(verifyMediaBytes(Buffer.from("WEBVTT\n\x00", "binary"), "SUBTITLE", "text/vtt")).toBeNull();
  });
});
