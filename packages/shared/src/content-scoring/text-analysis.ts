/**
 * Module 6 Phase 6.1 — small, deterministic text-analysis helpers shared
 * by scoring dimensions. Pure functions only: no I/O, no clock, no
 * randomness. Same string in → same numbers out.
 */

/** Split into words on any whitespace/punctuation run; drop empties. */
export function tokenizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

export function wordCount(text: string): number {
  return tokenizeWords(text).length;
}

/** Naive sentence split on . ! ? followed by space/end. Good enough for
 * an average-sentence-length readability heuristic. */
export function sentenceCount(text: string): number {
  const matches = text.trim().match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g);
  return matches ? matches.filter((s) => s.trim().length > 0).length : 0;
}

export function averageWordsPerSentence(text: string): number {
  const sentences = sentenceCount(text);
  if (sentences === 0) return wordCount(text); // one long run counts as one sentence
  return wordCount(text) / sentences;
}

/** Whole-phrase, case-insensitive occurrence count of `phrase` in
 * `text` (word-boundary aware for single tokens; substring for multi-
 * word phrases after whitespace normalization). */
export function phraseOccurrences(text: string, phrase: string): number {
  const needle = phrase.trim().toLowerCase();
  if (!needle) return 0;
  const haystack = text.toLowerCase().replace(/\s+/g, " ");
  if (needle.includes(" ")) {
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      count += 1;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
  }
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`, "gu");
  return (haystack.match(re) ?? []).length;
}

export function containsPhrase(text: string, phrase: string): boolean {
  return phraseOccurrences(text, phrase) > 0;
}

/** How many of `phrases` appear at least once in `text`. */
export function phraseCoverage(text: string, phrases: readonly string[]): number {
  return phrases.reduce((n, p) => (containsPhrase(text, p) ? n + 1 : n), 0);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map a raw value onto a 0–100 score by linear interpolation between an
 * ideal band [idealLow, idealHigh] (→ 100) and a floor/ceiling
 * (→ `floorScore`). Deterministic, monotone, and easy to explain in a
 * factor's `reason`.
 */
export function bandScore(
  value: number,
  opts: { min: number; idealLow: number; idealHigh: number; max: number; floorScore?: number },
): number {
  const floor = opts.floorScore ?? 0;
  if (value >= opts.idealLow && value <= opts.idealHigh) return 100;
  if (value <= opts.min || value >= opts.max) return floor;
  if (value < opts.idealLow) {
    const t = (value - opts.min) / (opts.idealLow - opts.min);
    return Math.round(floor + t * (100 - floor));
  }
  const t = (opts.max - value) / (opts.max - opts.idealHigh);
  return Math.round(floor + t * (100 - floor));
}

/** A simple ramp: `value` at or below `zeroAt` → 0, at or above
 * `fullAt` → 100, linear between. */
export function rampScore(value: number, zeroAt: number, fullAt: number): number {
  if (fullAt === zeroAt) return value >= fullAt ? 100 : 0;
  const t = (value - zeroAt) / (fullAt - zeroAt);
  return Math.round(Math.min(100, Math.max(0, t * 100)));
}
