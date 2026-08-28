import type { ImprovementRecommendation } from "./improvement-recommendation";
import type { ScoringFactor } from "./scoring-factor";
import type { ScoringInput } from "./scoring-input";

/**
 * Module 6 Phase 6.1 — the pluggable, content-type-specific contributor.
 *
 * MODULE_ROADMAP_V1.0.md §11: the Content Scoring Engine is
 * "content-type-agnostic (a shared scoring registry/contract, not
 * Blog-specific code)"; content-type-specific *dimensions* (Blog Score,
 * Video Score, Thumbnail Score — CONTENT_SCORING_ENGINE_V1.0.md §4–§6)
 * "plug into that one shared formula". This interface IS that plug.
 *
 * A dimension is the ONLY place any per-content-type scoring logic may
 * live. The generic engine (`content-scoring-engine.ts`) has zero
 * knowledge of Blog/Video/Thumbnail — it resolves a dimension by the
 * input's `contentType`, calls `evaluate` once, and does pure
 * aggregation on the result. Module 7 adds Video/Thumbnail by
 * registering two more of these; it never edits the engine, the
 * registry, or the Blog dimension (§11's Module 7 gate).
 *
 * `evaluate` MUST be deterministic and side-effect-free: same input →
 * byte-identical output, no I/O, no clock, no randomness. Phase 6.1
 * scoring is entirely deterministic (task rule 6).
 */
export interface ContentDimension {
  /** Stable registry key, lowercase — "blog", "video", "thumbnail". */
  readonly name: string;

  /** Monotonically increasing per `name`. `resolve()` picks the highest
   * when a caller omits the version. */
  readonly version: number;

  /** The frozen ContentType value(s) this dimension scores. The registry
   * indexes by these so the engine can resolve a dimension from a
   * `ScoringInput.contentType` alone. Must be non-empty. */
  readonly appliesTo: readonly string[];

  /** Display name of this dimension's own score, e.g. "Blog Score".
   * Distinct from the five universal categories — never feeds the
   * composite formula. */
  readonly dimensionScoreLabel: string;

  /** One-line description — introspection only. */
  readonly purpose: string;

  /**
   * The single content-type-specific step. Given normalized content,
   * produce contributions to the universal categories, this dimension's
   * own score, and improvement items.
   *
   * Contract enforced by the engine after this returns:
   *  - `categoryFactors` covers ALL FIVE universal categories (≥ 1
   *    factor each) — a dimension that leaves a category empty is
   *    rejected, because the composite formula needs all five.
   *  - every factor `value` and `dimensionScore` is in [0, 100].
   *  - factor ids are unique across categoryFactors + dimensionFactors.
   */
  evaluate(input: ScoringInput): DimensionEvaluation;
}

export interface DimensionEvaluation {
  /** Factors contributing to the five universal categories. Each MUST
   * carry a non-null `category`. */
  readonly categoryFactors: readonly ScoringFactor[];

  /** This dimension's own 0–100 score (the "Blog Score" value). */
  readonly dimensionScore: number;

  /** Factors explaining `dimensionScore`. Each MUST carry
   * `category: null`. May be empty. */
  readonly dimensionFactors: readonly ScoringFactor[];

  /** Deterministically-derived improvement items. May be empty. */
  readonly recommendations: readonly ImprovementRecommendation[];
}
