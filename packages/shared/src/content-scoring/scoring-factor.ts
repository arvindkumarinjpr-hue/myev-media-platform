import type { ScoreCategory } from "./score-category";

/**
 * Module 6 Phase 6.1 — the explainability primitive.
 *
 * CONTENT_SCORING_ENGINE_V1.0.md, Design Principles: "Explainable
 * Scores", "Multi-factor Evaluation". Every number this engine produces
 * is traceable to a set of these — a single measurable signal, its 0–100
 * value, how much it counts, and a plain-language reason.
 *
 * A factor is either:
 *  - `category`-tagged — it contributes to one of the five universal
 *    categories that feed the composite formula; or
 *  - `dimension`-scoped (category = null) — it explains a content-type
 *    dimension's own separately-named score (e.g. the "Blog Score"),
 *    which is NOT in the composite formula.
 */
export interface ScoringFactor {
  /** Stable, kebab-case identifier — unique within one ScoreResult.
   * Used for deterministic ordering and to let a recommendation point
   * back at the factor that triggered it. Never a display string. */
  readonly id: string;

  /** One universal category, or null for a dimension-only factor. */
  readonly category: ScoreCategory | null;

  /** Short human label, e.g. "Primary keyword in title". */
  readonly label: string;

  /** This signal's measured strength, 0–100. */
  readonly value: number;

  /** Relative importance within its category/dimension, > 0. Category
   * (or dimension) score = weighted mean of its factors' `value` by
   * `weight`. Weights need not sum to anything — only their ratios
   * matter. */
  readonly weight: number;

  /** Why the value is what it is — always populated, always specific
   * enough to act on ("No <h2> headings found", not "structure is
   * weak"). */
  readonly reason: string;

  /** Optional machine-readable specifics behind `reason` (counts,
   * matched terms) — for the UI's improvement checklist, never
   * interpreted by the engine. */
  readonly evidence?: Readonly<Record<string, string | number | boolean>>;
}

/** Weighted mean of a set of factor values by weight. Returns 0 for an
 * empty set (the engine never calls it with one — every category is
 * required to carry ≥ 1 factor — but a defined result keeps callers
 * total). */
export function weightedFactorMean(factors: readonly ScoringFactor[]): number {
  if (factors.length === 0) return 0;
  let weightedSum = 0;
  let weightTotal = 0;
  for (const f of factors) {
    weightedSum += f.value * f.weight;
    weightTotal += f.weight;
  }
  return weightTotal === 0 ? 0 : weightedSum / weightTotal;
}
