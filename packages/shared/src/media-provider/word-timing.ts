/**
 * Module 7 Phase 7.4 — provider-neutral word-level timing.
 *
 * The primary subtitle-alignment source (D3): TTS word timings, no
 * STT/Whisper. Only genuine spoken-word boundary events become
 * `WordTiming` entries — a provider's punctuation/sentence boundary
 * events must be filtered out by the adapter before they reach here.
 */
export interface WordTiming {
  /** The spoken word exactly as the provider reported it (no normalization here). */
  readonly word: string;
  /** Milliseconds from the start of the audio. Integer, >= 0. */
  readonly startMs: number;
  /** Milliseconds from the start of the audio. Integer, strictly > startMs. */
  readonly endMs: number;
}

export class WordTimingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WordTimingValidationError";
  }
}

/**
 * Validates a full word-timing stream. Throws `WordTimingValidationError`
 * on the first violation — a malformed stream must fail the pipeline
 * artifact loudly, never be silently accepted (checkpoint §2/§14).
 *
 *  - non-empty
 *  - every entry: integer startMs >= 0, integer endMs > startMs
 *  - non-empty trimmed word
 *  - monotonic: each entry's startMs >= the previous entry's startMs
 *
 * Small inter-word gaps and overlaps between adjacent words are allowed
 * (real TTS coarticulation produces them) — only strict start-time
 * regression is rejected.
 */
export function validateWordTimings(timings: readonly WordTiming[]): void {
  if (!Array.isArray(timings) || timings.length === 0) {
    throw new WordTimingValidationError("word-timing stream is empty");
  }
  let prevStart = -1;
  for (let i = 0; i < timings.length; i++) {
    const t = timings[i];
    if (!t || typeof t.word !== "string" || t.word.trim().length === 0) {
      throw new WordTimingValidationError(`word-timing entry ${i} has no word text`);
    }
    if (!Number.isInteger(t.startMs) || t.startMs < 0) {
      throw new WordTimingValidationError(`word-timing entry ${i} ("${t.word}") has an invalid startMs (${t.startMs})`);
    }
    if (!Number.isInteger(t.endMs) || t.endMs <= t.startMs) {
      throw new WordTimingValidationError(`word-timing entry ${i} ("${t.word}") has endMs (${t.endMs}) <= startMs (${t.startMs})`);
    }
    if (t.startMs < prevStart) {
      throw new WordTimingValidationError(`word-timing entry ${i} ("${t.word}") starts before the previous entry (${t.startMs} < ${prevStart})`);
    }
    prevStart = t.startMs;
  }
}
