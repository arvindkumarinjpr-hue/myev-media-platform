import type { LatestScoreResult, ScoreRunResult } from "./content-scoring.service";

/**
 * Module 6 Phase 6.1 — the API response shape for a content score.
 *
 * The `threshold` / `passed` fields are computed at THIS layer from
 * config (see scoring-threshold.ts) — they are deliberately not part of
 * the shared `ScoreResult` domain object. Callers get the full
 * explainable breakdown (overall + category scores + every factor +
 * recommendations) exactly as the frozen Reporting section requires,
 * and, alongside it, the gate decision.
 */
export function serializeScore(run: ScoreRunResult | LatestScoreResult) {
  const { result } = run;
  return {
    contentItemId: run.contentItemPublicId,
    contentScoreId: run.contentScorePublicId,
    seoReportId: "seoReportPublicId" in run ? run.seoReportPublicId : null,
    calculatedAt: run.calculatedAt,
    overallScore: result.overallScore,
    passThreshold: run.threshold.threshold,
    passed: run.threshold.passed,
    categoryScores: result.categoryScores,
    dimension: result.dimension,
    factors: result.factors,
    recommendations: result.recommendations,
  };
}
