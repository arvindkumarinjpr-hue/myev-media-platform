import { computeOverallContentScore, type CategoryScores } from "./composite-score";
import type { ContentDimension, DimensionEvaluation } from "./content-dimension";
import { SCORE_CATEGORIES, type ScoreCategory } from "./score-category";
import { assertInScoreRange, roundScore } from "./score-bounds";
import { weightedFactorMean, type ScoringFactor } from "./scoring-factor";
import type { ScoreResult } from "./score-result";
import { orderFactors, orderRecommendations } from "./serialization";
import type { ScoringInput } from "./scoring-input";

/**
 * Module 6 Phase 6.1 — the generic, content-type-AGNOSTIC scoring core.
 *
 * MODULE_ROADMAP_V1.0.md §11: "a shared scoring registry/contract, not
 * Blog-specific code". This file contains ZERO references to Blog,
 * Video, Thumbnail, or any ContentType value. All content-type-specific
 * logic is delegated to the injected `ContentDimension`. The engine's
 * only job is:
 *
 *   1. run the dimension once,
 *   2. validate the DimensionEvaluation contract loudly,
 *   3. aggregate category factors → the five universal category scores,
 *   4. apply the frozen composite formula → Overall,
 *   5. assemble a deterministically-ordered ScoreResult.
 *
 * Module 7 adds Video/Thumbnail scoring by registering new dimensions —
 * this file is not touched.
 */

export class ContentScoringEngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentScoringEngineError";
  }
}

export class ContentScoringEngine {
  /**
   * @param input     normalized content (built by the API layer)
   * @param dimension resolved from a registry by the caller — the engine
   *                  does not know how it was chosen
   */
  score(input: ScoringInput, dimension: ContentDimension): ScoreResult {
    const evaluation = dimension.evaluate(input);
    this.assertEvaluationContract(dimension, evaluation);

    const categoryScores = this.aggregateCategoryScores(evaluation.categoryFactors);
    const overallScore = computeOverallContentScore(categoryScores);

    const dimensionScore = roundScore(evaluation.dimensionScore);
    assertInScoreRange(`dimension "${dimension.name}" score`, dimensionScore);

    const allFactors = orderFactors([...evaluation.categoryFactors, ...evaluation.dimensionFactors]);
    const recommendations = orderRecommendations(evaluation.recommendations);

    return {
      overallScore,
      categoryScores,
      dimension: {
        name: dimension.name,
        version: dimension.version,
        label: dimension.dimensionScoreLabel,
        score: dimensionScore,
      },
      factors: allFactors,
      recommendations,
    };
  }

  /** Weighted mean of each category's factors → that category's 0–100
   * score. Every category is guaranteed ≥ 1 factor by the contract
   * check above, so no empty-category fallback is ever exercised. */
  private aggregateCategoryScores(categoryFactors: readonly ScoringFactor[]): CategoryScores {
    const byCategory = new Map<ScoreCategory, ScoringFactor[]>();
    for (const category of SCORE_CATEGORIES) byCategory.set(category, []);
    for (const factor of categoryFactors) {
      // `category` is non-null here — assertEvaluationContract enforced it.
      byCategory.get(factor.category as ScoreCategory)!.push(factor);
    }

    const scores = {} as Record<ScoreCategory, number>;
    for (const category of SCORE_CATEGORIES) {
      const factors = byCategory.get(category)!;
      const mean = weightedFactorMean(factors);
      scores[category] = roundScore(mean);
      assertInScoreRange(`aggregated category score "${category}"`, scores[category]);
    }
    return scores;
  }

  private assertEvaluationContract(dimension: ContentDimension, evaluation: DimensionEvaluation): void {
    const where = `dimension "${dimension.name}@v${dimension.version}"`;

    // 1. every factor value in range; ids unique across the whole result.
    const seenIds = new Set<string>();
    const allFactors = [...evaluation.categoryFactors, ...evaluation.dimensionFactors];
    for (const factor of allFactors) {
      if (!factor.id) throw new ContentScoringEngineError(`${where} returned a factor with an empty id`);
      if (seenIds.has(factor.id)) {
        throw new ContentScoringEngineError(`${where} returned duplicate factor id "${factor.id}"`);
      }
      seenIds.add(factor.id);
      if (!(factor.weight > 0)) {
        throw new ContentScoringEngineError(`${where} factor "${factor.id}" must have weight > 0 — got ${factor.weight}`);
      }
      assertInScoreRange(`${where} factor "${factor.id}" value`, factor.value);
    }

    // 2. category factors carry a real category; dimension factors carry none.
    for (const factor of evaluation.categoryFactors) {
      if (factor.category === null) {
        throw new ContentScoringEngineError(`${where} category factor "${factor.id}" must declare a category`);
      }
    }
    for (const factor of evaluation.dimensionFactors) {
      if (factor.category !== null) {
        throw new ContentScoringEngineError(`${where} dimension factor "${factor.id}" must have category: null (got "${factor.category}")`);
      }
    }

    // 3. ALL FIVE universal categories covered — the composite needs them.
    const covered = new Set(evaluation.categoryFactors.map((f) => f.category));
    const missing = SCORE_CATEGORIES.filter((c) => !covered.has(c));
    if (missing.length > 0) {
      throw new ContentScoringEngineError(
        `${where} must return at least one factor for every universal category — missing: ${missing.join(", ")}`,
      );
    }

    // 4. recommendation ids unique; relatedFactorId (when set) resolves.
    const seenRecIds = new Set<string>();
    for (const rec of evaluation.recommendations) {
      if (!rec.id) throw new ContentScoringEngineError(`${where} returned a recommendation with an empty id`);
      if (seenRecIds.has(rec.id)) {
        throw new ContentScoringEngineError(`${where} returned duplicate recommendation id "${rec.id}"`);
      }
      seenRecIds.add(rec.id);
      if (rec.relatedFactorId !== undefined && !seenIds.has(rec.relatedFactorId)) {
        throw new ContentScoringEngineError(
          `${where} recommendation "${rec.id}" points at unknown factor "${rec.relatedFactorId}"`,
        );
      }
    }
  }
}
