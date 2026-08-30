/**
 * Module 7 Phase 7.4 — provider-neutral text-to-speech contract.
 *
 * The TTS analogue of `ai-provider/ai-request.ts` + `ai-response.ts`.
 * Plain interfaces. No Azure / ElevenLabs / vendor SDK type appears
 * here.
 *
 * V1 primary provider = Azure AI Speech (native WordBoundary events).
 * For the V1 provider, `wordTimings` is MANDATORY on a successful
 * result — subtitle generation (D3) depends on it and there is no
 * STT fallback in Phase 7.4.
 */
import type { WordTiming } from "./word-timing";

export type TtsOutputFormat = "mp3" | "wav" | "ogg_opus";

/** Provider-neutral delivery hint — an adapter maps or ignores it. */
export type TtsStyleHint = "neutral" | "newscast" | "cheerful" | "calm";

export interface TtsRequest {
  /** The approved script text, already resolved. */
  readonly text: string;
  /** Opaque catalog id (see the config-driven voice catalog) — the adapter maps it to the vendor voice. */
  readonly voiceProfileId: string;
  /** Vendor voice identifier resolved from the catalog by the caller — the adapter uses this, never `voiceProfileId` directly. */
  readonly providerVoiceId: string;
  /** BCP-47, e.g. "en-IN", "hi-IN". */
  readonly language: string;
  /** 1.0 = normal. */
  readonly speed?: number;
  readonly style?: TtsStyleHint;
  readonly outputFormat: TtsOutputFormat;

  readonly workspaceId: string;
  readonly contentItemId?: string;
  readonly correlationId: string;
  readonly idempotencyKey?: string;
}

export interface TtsUsage {
  readonly characterCount: number;
  readonly audioSeconds: number;
}

export interface TtsResult {
  readonly audioBytes: Buffer;
  readonly mimeType: string;
  readonly codec: string;
  readonly durationMs: number;
  /**
   * Word-level timing. Optional in the contract (a hypothetical future
   * provider that cannot supply it never fabricates it) — but ALWAYS
   * present from the V1 provider. A processor treats its absence as a
   * pipeline-artifact failure.
   */
  readonly wordTimings?: readonly WordTiming[];
  readonly provider: string;
  readonly model: string;
  readonly usage?: TtsUsage;
  /** Absent — never fabricated — when no per-character price is configured. */
  readonly costEstimate?: number;
  readonly providerRequestId?: string;
  readonly correlationId: string;
}

export interface TtsVoiceDescriptor {
  readonly providerVoiceId: string;
  readonly language: string;
  readonly displayName: string;
  readonly styles: readonly TtsStyleHint[];
}

/** The adapter contract every TTS provider implements — mirrors `AIProvider`. */
export interface TtsProvider {
  /** Stable id — e.g. "azure", "elevenlabs". */
  readonly id: string;

  /**
   * Synthesizes speech. MUST throw `MediaProviderError` (never a raw SDK
   * error) on any failure. `signal` aborts the in-flight call.
   */
  synthesize(request: TtsRequest, signal?: AbortSignal): Promise<TtsResult>;

  /** Registry-introspection only. */
  listVoices(): TtsVoiceDescriptor[];
}
