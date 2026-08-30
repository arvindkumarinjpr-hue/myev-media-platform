/**
 * Module 7 Phase 7.4 — deterministic subtitle generation (D3).
 *
 * Pure logic, no I/O, no AI, no STT. Input: the approved script narration
 * text + the TTS word-timing stream. Output: SRT + VTT documents and a
 * cue count. Fully deterministic — the same inputs always produce the
 * same bytes.
 *
 * Alignment: the script text is the authority for WHAT is said; the
 * timing stream is the authority for WHEN. Both are tokenized into words
 * and aligned 1:1. A length mismatch beyond `WORD_COUNT_TOLERANCE`
 * throws `SubtitleAlignmentError` — a bad alignment fails the subtitle
 * job loudly, it is never silently guessed.
 */
import { validateWordTimings, type WordTiming } from "./word-timing";

export class SubtitleAlignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubtitleAlignmentError";
  }
}

export interface SubtitleCue {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  readonly lines: readonly string[];
}

export interface SubtitleBuildResult {
  readonly srt: string;
  readonly vtt: string;
  readonly cues: readonly SubtitleCue[];
  readonly cueCount: number;
}

export interface SubtitleBuildOptions {
  /** Total audio length — every cue must fall within [0, audioDurationMs]. */
  readonly audioDurationMs: number;
  readonly maxCharsPerLine?: number;
  readonly maxLinesPerCue?: number;
  readonly maxCueDurationMs?: number;
  readonly minCueDurationMs?: number;
}

const DEFAULTS = {
  maxCharsPerLine: 42,
  maxLinesPerCue: 2,
  maxCueDurationMs: 6000,
  minCueDurationMs: 700,
};

/** Alignment tolerates a small mismatch (a provider may split hyphenates differently). */
const WORD_COUNT_TOLERANCE = 0.1;

function tokenize(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 0);
}

function stripForCompare(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function endsSentence(word: string): boolean {
  return /[.!?…]["')\]]?$/.test(word);
}

function formatTimestamp(ms: number, sep: "," | "."): string {
  const clamped = Math.max(0, Math.round(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(millis, 3)}`;
}

function wrapLines(words: string[], maxCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  // If the text overflows the cue's line budget, keep the first N-1 lines
  // as-is and let the last line hold the remainder (readability degrades
  // gracefully rather than dropping words).
  if (lines.length > maxLines) {
    const head = lines.slice(0, maxLines - 1);
    const tail = lines.slice(maxLines - 1).join(" ");
    return [...head, tail];
  }
  return lines;
}

/**
 * Builds SRT + VTT from the approved script narration and the TTS word
 * timings. Throws:
 *  - `WordTimingValidationError` (re-thrown) if the timing stream is malformed
 *  - `SubtitleAlignmentError` if the word counts diverge beyond tolerance,
 *    or a produced cue would fall outside the audio, overlap, or be shorter
 *    than the floor.
 */
export function buildSubtitles(scriptText: string, wordTimings: readonly WordTiming[], options: SubtitleBuildOptions): SubtitleBuildResult {
  validateWordTimings(wordTimings);

  const opts = { ...DEFAULTS, ...options };
  if (!Number.isFinite(opts.audioDurationMs) || opts.audioDurationMs <= 0) {
    throw new SubtitleAlignmentError(`audioDurationMs must be a positive number (got ${opts.audioDurationMs})`);
  }

  const scriptWords = tokenize(scriptText);
  if (scriptWords.length === 0) {
    throw new SubtitleAlignmentError("script text produced no words");
  }

  const timingWords = wordTimings.length;
  const diff = Math.abs(scriptWords.length - timingWords);
  if (diff > Math.max(2, Math.ceil(Math.max(scriptWords.length, timingWords) * WORD_COUNT_TOLERANCE))) {
    throw new SubtitleAlignmentError(
      `script has ${scriptWords.length} words but the timing stream has ${timingWords} — mismatch beyond tolerance, refusing to guess`,
    );
  }

  // Align by index. Where counts differ slightly, the script text wins
  // for display and the nearest timing entry supplies the clock; trailing
  // words past the timing stream inherit the last timing's end.
  const n = scriptWords.length;
  const aligned: { word: string; startMs: number; endMs: number }[] = [];
  for (let i = 0; i < n; i++) {
    const timing = wordTimings[Math.min(i, wordTimings.length - 1)];
    aligned.push({ word: scriptWords[i], startMs: timing.startMs, endMs: timing.endMs });
  }

  // Segment into cues.
  const rawCues: { words: string[]; startMs: number; endMs: number }[] = [];
  let bucket: string[] = [];
  let bucketStart = aligned[0].startMs;
  let bucketChars = 0;
  const lineBudget = opts.maxCharsPerLine * opts.maxLinesPerCue;

  for (let i = 0; i < aligned.length; i++) {
    const { word, endMs } = aligned[i];
    if (bucket.length === 0) bucketStart = aligned[i].startMs;
    bucket.push(word);
    bucketChars += word.length + 1;

    const wouldOverflow = bucketChars >= lineBudget;
    const tooLong = endMs - bucketStart >= opts.maxCueDurationMs;
    const sentenceBreak = endsSentence(word) && bucketChars >= opts.maxCharsPerLine * 0.6;
    const isLast = i === aligned.length - 1;

    if (wouldOverflow || tooLong || sentenceBreak || isLast) {
      rawCues.push({ words: [...bucket], startMs: bucketStart, endMs });
      bucket = [];
      bucketChars = 0;
    }
  }

  // Validate + normalize cue timing.
  const cues: SubtitleCue[] = [];
  let prevEnd = -1;
  for (let i = 0; i < rawCues.length; i++) {
    const raw = rawCues[i];
    let startMs = Math.max(raw.startMs, prevEnd + 1, 0);
    let endMs = Math.max(raw.endMs, startMs + opts.minCueDurationMs);

    if (endMs > opts.audioDurationMs) {
      // The last cue may legitimately touch the audio end; an earlier cue
      // running past it means the alignment is wrong.
      if (i === rawCues.length - 1) {
        endMs = opts.audioDurationMs;
        if (endMs <= startMs) startMs = Math.max(0, endMs - opts.minCueDurationMs);
      } else {
        throw new SubtitleAlignmentError(`cue ${i + 1} ends at ${endMs}ms, past the audio duration ${opts.audioDurationMs}ms`);
      }
    }
    if (endMs <= startMs) {
      throw new SubtitleAlignmentError(`cue ${i + 1} has a non-positive duration (${startMs}..${endMs})`);
    }

    cues.push({ index: i + 1, startMs, endMs, lines: wrapLines(raw.words, opts.maxCharsPerLine, opts.maxLinesPerCue) });
    prevEnd = endMs;
  }

  if (cues.length === 0) {
    throw new SubtitleAlignmentError("no cues were produced");
  }

  return {
    srt: renderSrt(cues),
    vtt: renderVtt(cues),
    cues,
    cueCount: cues.length,
  };
}

function renderSrt(cues: readonly SubtitleCue[]): string {
  return (
    cues
      .map((cue) => `${cue.index}\n${formatTimestamp(cue.startMs, ",")} --> ${formatTimestamp(cue.endMs, ",")}\n${cue.lines.join("\n")}`)
      .join("\n\n") + "\n"
  );
}

function renderVtt(cues: readonly SubtitleCue[]): string {
  return (
    "WEBVTT\n\n" +
    cues
      .map((cue) => `${cue.index}\n${formatTimestamp(cue.startMs, ".")} --> ${formatTimestamp(cue.endMs, ".")}\n${cue.lines.join("\n")}`)
      .join("\n\n") +
    "\n"
  );
}

/** True when `word` (from the timing stream) roughly matches `scriptWord` — used only by tests / diagnostics. */
export function wordsRoughlyMatch(a: string, b: string): boolean {
  return stripForCompare(a) === stripForCompare(b);
}
