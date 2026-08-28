/**
 * Module 6 Phase 6.1 — every score in this engine (each category score,
 * each dimension score, the overall composite, every factor value) is on
 * a single fixed 0–100 scale, matching CONTENT_SCORING_ENGINE_V1.0.md's
 * "Range: 0--100" note on every category.
 *
 * Kept as a standalone module so the bound is stated exactly once and
 * reused by the engine, the dimensions, the registry validation, and the
 * (de)serialization round-trip.
 */
export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

export class ScoreOutOfRangeError extends Error {
  constructor(
    readonly label: string,
    readonly value: number,
  ) {
    super(`${label} must be a finite number in [${SCORE_MIN}, ${SCORE_MAX}] — got ${value}`);
    this.name = "ScoreOutOfRangeError";
  }
}

export function isInScoreRange(value: number): boolean {
  return Number.isFinite(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

/**
 * Assert a value is a valid score. Used at every trust boundary — after
 * a dimension returns, before the engine aggregates, before persistence.
 * A dimension that emits an out-of-range number is a bug, surfaced loudly
 * here rather than silently clamped away.
 */
export function assertInScoreRange(label: string, value: number): void {
  if (!isInScoreRange(value)) {
    throw new ScoreOutOfRangeError(label, value);
  }
}

/**
 * Clamp a computed aggregate into range. Only used on values the engine
 * itself derives by arithmetic (weighted means, rounding) where a
 * floating-point result can land a hair outside [0, 100] — never used to
 * paper over a dimension's own bad output (that path uses
 * `assertInScoreRange`).
 */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return SCORE_MIN;
  return Math.min(SCORE_MAX, Math.max(SCORE_MIN, value));
}

/** Round to an integer score. The engine reports whole numbers; factor
 * math is done in floating point and rounded once, at the end. */
export function roundScore(value: number): number {
  return Math.round(clampScore(value));
}
