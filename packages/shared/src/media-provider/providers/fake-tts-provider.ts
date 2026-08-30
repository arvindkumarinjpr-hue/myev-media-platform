import { MediaProviderError, MediaProviderErrorCode } from "../media-provider-error";
import type { TtsProvider, TtsRequest, TtsResult, TtsVoiceDescriptor } from "../tts.contract";
import type { WordTiming } from "../word-timing";

export type FakeTtsMode = "success" | "success_no_timings" | "transient_error" | "permanent_error" | "moderation" | "timeout" | "rate_limit" | "flaky_then_success";

// A tiny but real WAV (RIFF/WAVE header + a few silent samples) — passes
// the magic-byte sniffer (`audio/wav`).
const SILENT_WAV = (() => {
  const dataBytes = 32;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
})();

/** Deterministic word timings: 400ms/word, 60ms gap. */
function fakeTimings(text: string): { timings: WordTiming[]; durationMs: number } {
  const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const timings: WordTiming[] = [];
  let cursor = 0;
  for (const word of words) {
    const startMs = cursor;
    const endMs = cursor + 380;
    timings.push({ word, startMs, endMs });
    cursor = endMs + 60;
  }
  return { timings, durationMs: cursor };
}

/**
 * Module 7 Phase 7.4 — deterministic fake TTS provider. Zero spend, zero
 * network. `success` returns a valid word-timing stream (the V1
 * contract); `success_no_timings` returns audio with NO timings so a
 * processor's "TTS must supply word timings" guard can be tested.
 */
export class FakeTtsProvider implements TtsProvider {
  readonly id: string;
  private callCount = 0;

  constructor(
    private readonly mode: FakeTtsMode = "success",
    private readonly failuresBeforeSuccess = 1,
    id = "fake-tts",
  ) {
    this.id = id;
  }

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    if (signal?.aborted) {
      throw new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "Request was aborted before the fake TTS provider could respond.", this.id);
    }

    if (this.mode === "flaky_then_success") {
      this.callCount += 1;
      if (this.callCount <= this.failuresBeforeSuccess) {
        throw new MediaProviderError(MediaProviderErrorCode.TRANSIENT_NETWORK, `Fake TTS provider: simulated transient failure (${this.callCount}/${this.failuresBeforeSuccess}).`, this.id);
      }
    }

    switch (this.mode) {
      case "transient_error":
        throw new MediaProviderError(MediaProviderErrorCode.PROVIDER_UNAVAILABLE, "Fake TTS provider: simulated provider outage.", this.id);
      case "permanent_error":
        throw new MediaProviderError(MediaProviderErrorCode.INVALID_REQUEST, "Fake TTS provider: simulated invalid request.", this.id);
      case "moderation":
        throw new MediaProviderError(MediaProviderErrorCode.CONTENT_MODERATION, "Fake TTS provider: text rejected by content policy.", this.id);
      case "timeout":
        throw new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "Fake TTS provider: simulated timeout.", this.id);
      case "rate_limit":
        throw new MediaProviderError(MediaProviderErrorCode.RATE_LIMIT, "Fake TTS provider: simulated rate limit.", this.id, { retryAfterSeconds: 1 });
    }

    const { timings, durationMs } = fakeTimings(request.text);
    return {
      audioBytes: SILENT_WAV,
      mimeType: "audio/wav",
      codec: "pcm_s16le",
      durationMs: Math.max(durationMs, 100),
      wordTimings: this.mode === "success_no_timings" ? undefined : timings,
      provider: this.id,
      model: "fake-tts-model-1",
      usage: { characterCount: request.text.length, audioSeconds: Math.max(durationMs, 100) / 1000 },
      providerRequestId: `fake-tts-${request.correlationId}`,
      correlationId: request.correlationId,
    };
  }

  listVoices(): TtsVoiceDescriptor[] {
    return [
      { providerVoiceId: "fake-en-IN", language: "en-IN", displayName: "Fake Indian English", styles: ["neutral", "newscast"] },
      { providerVoiceId: "fake-hi-IN", language: "hi-IN", displayName: "Fake Hindi", styles: ["neutral"] },
    ];
  }
}
