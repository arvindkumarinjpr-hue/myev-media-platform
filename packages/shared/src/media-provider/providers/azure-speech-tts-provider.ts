import type * as SpeechSdk from "microsoft-cognitiveservices-speech-sdk";
import { MediaProviderError, MediaProviderErrorCode } from "../media-provider-error";
import type { TtsProvider, TtsRequest, TtsResult, TtsVoiceDescriptor } from "../tts.contract";
import type { WordTiming } from "../word-timing";

/**
 * Module 7 Phase 7.4 — Azure AI Speech Neural TTS adapter (D2 primary).
 *
 * Chosen for native `WordBoundary` events → deterministic subtitles with
 * NO STT/Whisper (D3). The synthesizer runs with a null audio config so
 * audio is captured in memory; `wordBoundary` events are collected and
 * converted to `WordTiming[]` (100-nanosecond ticks → integer
 * milliseconds). ONLY `Word` boundary events become entries —
 * punctuation and sentence boundary events are dropped, so a comma or a
 * full stop is never emitted as a spoken word.
 *
 * `microsoft-cognitiveservices-speech-sdk` is a declared dependency of
 * this package (packages/shared). It is loaded via `await import(...)`
 * purely for LAZY loading — the SDK is heavy and only ever needed when a
 * deployment has actually selected + credentialed the Azure provider;
 * `import type` above keeps full compile-time typing. Missing
 * credentials fail safe with `AUTH_CONFIG` and never touch the SDK.
 */

const TICKS_PER_MS = 10_000;

let sdkPromise: Promise<typeof SpeechSdk> | undefined;
function loadSdk(): Promise<typeof SpeechSdk> {
  sdkPromise ??= import("microsoft-cognitiveservices-speech-sdk");
  return sdkPromise;
}

export interface AzureSpeechTtsProviderConfig {
  readonly subscriptionKey: string;
  readonly region: string;
  /** Optional per-character price for cost estimation — omitted means costEstimate stays absent. */
  readonly costPerCharacter?: number;
  /** Voice catalog for `listVoices()` introspection. */
  readonly voices: readonly TtsVoiceDescriptor[];
}

const OUTPUT_FORMAT_KEY: Record<TtsRequest["outputFormat"], keyof typeof SpeechSdk.SpeechSynthesisOutputFormat> = {
  mp3: "Audio24Khz96KBitRateMonoMp3",
  wav: "Riff24Khz16BitMonoPcm",
  ogg_opus: "Ogg24Khz16BitMonoOpus",
};

const MIME_BY_FORMAT: Record<TtsRequest["outputFormat"], { mimeType: string; codec: string }> = {
  mp3: { mimeType: "audio/mpeg", codec: "mp3" },
  wav: { mimeType: "audio/wav", codec: "pcm_s16le" },
  ogg_opus: { mimeType: "audio/ogg", codec: "opus" },
};

export class AzureSpeechTtsProvider implements TtsProvider {
  readonly id = "azure";

  constructor(private readonly config: AzureSpeechTtsProviderConfig) {}

  async synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult> {
    if (signal?.aborted) {
      throw new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "TTS request was aborted before synthesis started.", this.id);
    }
    if (!request.text.trim()) {
      throw new MediaProviderError(MediaProviderErrorCode.INVALID_REQUEST, "TTS text is empty.", this.id);
    }
    if (!this.config.subscriptionKey || !this.config.region) {
      throw new MediaProviderError(MediaProviderErrorCode.AUTH_CONFIG, "Azure Speech credentials are not configured.", this.id);
    }

    const sdk = await loadSdk();
    const speechConfig = sdk.SpeechConfig.fromSubscription(this.config.subscriptionKey, this.config.region);
    speechConfig.speechSynthesisVoiceName = request.providerVoiceId;
    speechConfig.speechSynthesisLanguage = request.language;
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat[OUTPUT_FORMAT_KEY[request.outputFormat]];

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
    const wordTimings: WordTiming[] = [];

    synthesizer.wordBoundary = (_sender, event) => {
      // Only genuine spoken-word boundaries — never punctuation/sentence.
      if (event.boundaryType !== sdk.SpeechSynthesisBoundaryType.Word) return;
      const text = (event.text ?? "").trim();
      if (!text) return;
      const startMs = Math.round(event.audioOffset / TICKS_PER_MS);
      const endMs = startMs + Math.max(1, Math.round((event.duration ?? 0) / TICKS_PER_MS));
      wordTimings.push({ word: text, startMs: Math.max(0, startMs), endMs });
    };

    const onAbort = () => synthesizer.close();
    signal?.addEventListener("abort", onAbort, { once: true });

    let result: SpeechSdk.SpeechSynthesisResult;
    try {
      result = await new Promise<SpeechSdk.SpeechSynthesisResult>((resolve, reject) => {
        synthesizer.speakTextAsync(
          request.text,
          (r) => resolve(r),
          (err) => reject(new Error(err)),
        );
      });
    } catch (err) {
      throw this.normalize(err, signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
      try {
        synthesizer.close();
      } catch {
        /* already closed */
      }
    }

    if (result.reason === sdk.ResultReason.Canceled) {
      throw this.normalize(new Error(result.errorDetails || "synthesis canceled"), signal);
    }
    const audioBytes = Buffer.from(result.audioData);
    if (audioBytes.length === 0) {
      throw new MediaProviderError(MediaProviderErrorCode.MALFORMED_RESPONSE, "Azure returned empty audio.", this.id);
    }

    const durationMs =
      result.audioDuration > 0 ? Math.round(result.audioDuration / TICKS_PER_MS) : wordTimings.length > 0 ? wordTimings[wordTimings.length - 1].endMs : 0;

    if (durationMs <= 0) {
      throw new MediaProviderError(MediaProviderErrorCode.MALFORMED_RESPONSE, "Azure synthesis produced audio with no measurable duration.", this.id);
    }
    if (wordTimings.length === 0) {
      throw new MediaProviderError(MediaProviderErrorCode.MALFORMED_RESPONSE, "Azure synthesis produced no word-boundary events — cannot align subtitles.", this.id);
    }

    const { mimeType, codec } = MIME_BY_FORMAT[request.outputFormat];
    return {
      audioBytes,
      mimeType,
      codec,
      durationMs,
      wordTimings,
      provider: this.id,
      model: request.providerVoiceId,
      usage: { characterCount: request.text.length, audioSeconds: durationMs / 1000 },
      ...(this.config.costPerCharacter !== undefined ? { costEstimate: this.config.costPerCharacter * request.text.length } : {}),
      correlationId: request.correlationId,
    };
  }

  listVoices(): TtsVoiceDescriptor[] {
    return [...this.config.voices];
  }

  private normalize(err: unknown, signal?: AbortSignal): MediaProviderError {
    if (signal?.aborted) {
      return new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "TTS synthesis exceeded its time budget.", this.id);
    }
    if (err instanceof MediaProviderError) return err;
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (message.includes("401") || message.includes("403") || message.includes("forbidden") || message.includes("unauthorized")) {
      return new MediaProviderError(MediaProviderErrorCode.AUTH_CONFIG, "Azure Speech rejected the credentials.", this.id);
    }
    if (message.includes("429") || message.includes("throttl") || message.includes("rate")) {
      return new MediaProviderError(MediaProviderErrorCode.RATE_LIMIT, "Azure Speech rate limit reached.", this.id);
    }
    if (message.includes("timeout") || message.includes("timed out")) {
      return new MediaProviderError(MediaProviderErrorCode.TIMEOUT, "Azure Speech synthesis timed out.", this.id);
    }
    if (message.includes("invalid") || message.includes("bad request") || message.includes("400")) {
      return new MediaProviderError(MediaProviderErrorCode.INVALID_REQUEST, "Azure Speech rejected the request as invalid.", this.id);
    }
    if (message.includes("connection") || message.includes("network") || message.includes("econnreset")) {
      return new MediaProviderError(MediaProviderErrorCode.TRANSIENT_NETWORK, "Network failure reaching Azure Speech.", this.id);
    }
    return new MediaProviderError(MediaProviderErrorCode.PROVIDER_UNAVAILABLE, "Azure Speech synthesis failed.", this.id);
  }
}
