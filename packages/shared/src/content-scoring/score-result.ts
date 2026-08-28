import type { CategoryScores } from "./composite-score";
import type { ImprovementRecommendation } from "./improvement-recommendation";
import type { ScoringFactor } from "./scoring-factor";

/**
 * Module 6 Phase 6.1 — the complete, explainable output of one scoring
 * run. Everything the frozen spec's Reporting section needs
 * ("Overall score", "Individual score breakdown", "Improvement
 * checklist") plus the content-type dimension's own score.
 *
 * This object is deterministic: same ScoringInput + same dimension →
 * structurally identical ScoreResult, with factors and recommendations
 * in a stable order (see `serialization.ts`). `generatedAt` is NOT set
 * by the engine — the API layer stamps it at persistence time so the
 * pure engine stays clock-free.
 */
export interface ScoreResult {
  /** The frozen composite (mean of the five category scores), 0–100. */
  readonly overallScore: number;

  /** The five universal category scores, each 0–100. */
  readonly categoryScores: CategoryScores;

  /** The resolved content-type dimension's identity + its own score
   * (e.g. name "blog", label "Blog Score", score 0–100). Separate from
   * the composite — never folded into `overallScore`. */
  readonly dimension: {
    readonly name: string;
    readonly version: number;
    readonly label: string;
    readonly score: number;
  };

  /** Every factor behind every number — category-tagged factors and the
   * dimension-only factors together, in canonical order. */
  readonly factors: readonly ScoringFactor[];

  /** Deterministically-derived improvement checklist, in priority
   * order. */
  readonly recommendations: readonly ImprovementRecommendation[];
}
