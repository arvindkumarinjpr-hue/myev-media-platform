import { SCORE_CATEGORIES, scoreCategoryOrder, type ScoreCategory } from "./score-category";
import type { CategoryScores } from "./composite-score";
import { recommendationPriorityOrder, type ImprovementRecommendation } from "./improvement-recommendation";
import type { ScoringFactor } from "./scoring-factor";
import type { ScoreResult } from "./score-result";

/**
 * Module 6 Phase 6.1 — deterministic ordering + a stable
 * (de)serialization round-trip for persistence.
 *
 * The scoring engine is deterministic in its numbers; this module makes
 * it deterministic in its *shape* too, so:
 *  - the persisted `content_scores.factors` / `seo_reports.breakdown`
 *    JSON is byte-stable for the same input (diff-friendly, testable);
 *  - the API can round-trip a stored score back into a ScoreResult
 *    without the engine.
 */

/** category factors first (in SCORE_CATEGORIES order), then dimension
 * factors; ties broken by factor id. */
export function orderFactors(factors: readonly ScoringFactor[]): ScoringFactor[] {
  return [...factors].sort((a, b) => {
    const aKey = a.category === null ? SCORE_CATEGORIES.length : scoreCategoryOrder(a.category);
    const bKey = b.category === null ? SCORE_CATEGORIES.length : scoreCategoryOrder(b.category);
    if (aKey !== bKey) return aKey - bKey;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** HIGH → MEDIUM → LOW, ties broken by id. */
export function orderRecommendations(recs: readonly ImprovementRecommendation[]): ImprovementRecommendation[] {
  return [...recs].sort((a, b) => {
    const p = recommendationPriorityOrder(a.priority) - recommendationPriorityOrder(b.priority);
    if (p !== 0) return p;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** category scores as an object with keys always in SCORE_CATEGORIES
 * order. */
export function orderedCategoryScores(scores: CategoryScores): Record<ScoreCategory, number> {
  const ordered = {} as Record<ScoreCategory, number>;
  for (const category of SCORE_CATEGORIES) ordered[category] = scores[category];
  return ordered;
}

/** The persisted JSON shape of a full score result — what goes into
 * `content_scores.factors`. Kept explicit (not `ScoreResult` itself) so
 * a schema change here is a deliberate, reviewable edit. */
export interface ScoreResultJSON {
  readonly schemaVersion: 1;
  readonly overallScore: number;
  readonly categoryScores: Record<ScoreCategory, number>;
  readonly dimension: { readonly name: string; readonly version: number; readonly label: string; readonly score: number };
  readonly factors: ReadonlyArray<{
    readonly id: string;
    readonly category: ScoreCategory | null;
    readonly label: string;
    readonly value: number;
    readonly weight: number;
    readonly reason: string;
    readonly evidence?: Readonly<Record<string, string | number | boolean>>;
  }>;
  readonly recommendations: ReadonlyArray<{
    readonly id: string;
    readonly priority: ImprovementRecommendation["priority"];
    readonly category: ScoreCategory | null;
    readonly message: string;
    readonly relatedFactorId?: string;
  }>;
}

export function serializeScoreResult(result: ScoreResult): ScoreResultJSON {
  return {
    schemaVersion: 1,
    overallScore: result.overallScore,
    categoryScores: orderedCategoryScores(result.categoryScores),
    dimension: { ...result.dimension },
    factors: orderFactors(result.factors).map((f) => ({
      id: f.id,
      category: f.category,
      label: f.label,
      value: f.value,
      weight: f.weight,
      reason: f.reason,
      ...(f.evidence ? { evidence: { ...f.evidence } } : {}),
    })),
    recommendations: orderRecommendations(result.recommendations).map((r) => ({
      id: r.id,
      priority: r.priority,
      category: r.category,
      message: r.message,
      ...(r.relatedFactorId ? { relatedFactorId: r.relatedFactorId } : {}),
    })),
  };
}

export function deserializeScoreResult(json: ScoreResultJSON): ScoreResult {
  return {
    overallScore: json.overallScore,
    categoryScores: orderedCategoryScores(json.categoryScores),
    dimension: { ...json.dimension },
    factors: json.factors.map((f) => ({
      id: f.id,
      category: f.category,
      label: f.label,
      value: f.value,
      weight: f.weight,
      reason: f.reason,
      ...(f.evidence ? { evidence: { ...f.evidence } } : {}),
    })),
    recommendations: json.recommendations.map((r) => ({
      id: r.id,
      priority: r.priority,
      category: r.category,
      message: r.message,
      ...(r.relatedFactorId ? { relatedFactorId: r.relatedFactorId } : {}),
    })),
  };
}

/** The persisted JSON shape of the SEO slice — what goes into
 * `seo_reports.breakdown`. FR-SEO-003 AC: "Score breakdown individually
 * retrievable, not just the composite." */
export interface SeoBreakdownJSON {
  readonly schemaVersion: 1;
  readonly seoScore: number;
  readonly factors: ScoreResultJSON["factors"];
  readonly recommendations: ScoreResultJSON["recommendations"];
}

export function serializeSeoBreakdown(result: ScoreResult): SeoBreakdownJSON {
  const seoFactors = orderFactors(result.factors.filter((f) => f.category === "SEO"));
  const seoFactorIds = new Set(seoFactors.map((f) => f.id));
  const seoRecs = orderRecommendations(
    result.recommendations.filter((r) => r.category === "SEO" || (r.relatedFactorId !== undefined && seoFactorIds.has(r.relatedFactorId))),
  );
  return {
    schemaVersion: 1,
    seoScore: result.categoryScores.SEO,
    factors: seoFactors.map((f) => ({
      id: f.id,
      category: f.category,
      label: f.label,
      value: f.value,
      weight: f.weight,
      reason: f.reason,
      ...(f.evidence ? { evidence: { ...f.evidence } } : {}),
    })),
    recommendations: seoRecs.map((r) => ({
      id: r.id,
      priority: r.priority,
      category: r.category,
      message: r.message,
      ...(r.relatedFactorId ? { relatedFactorId: r.relatedFactorId } : {}),
    })),
  };
}
