import { SCORE_CATEGORIES, type ScoreCategory } from "./score-category";
import { assertInScoreRange, roundScore } from "./score-bounds";

/**
 * Module 6 Phase 6.1 — the FROZEN Composite Score formula.
 *
 * CONTENT_SCORING_ENGINE_V1.0.md:
 *
 *   SEO Score + Viral Score + Quality Score + Engagement Score
 *     + Business Score  →  Overall Content Score
 *
 * Every category input is on a 0–100 scale and the Overall must also be
 * 0–100 (the spec states "Range: 0--100" for the categories and calls
 * Overall "the composite"). A raw sum would be 0–500, so the only
 * scale-consistent realisation of the spec's "+ … → Overall" is an
 * EQUAL-WEIGHT MEAN of the five category scores.
 *
 * This is frozen product policy, NOT configuration:
 *  - the five inputs are fixed (see SCORE_CATEGORIES);
 *  - the weighting is equal — the spec assigns none, and "Custom
 *    scoring weights" is explicitly a *Future Enhancement* in the same
 *    document, so no weight configuration is added here;
 *  - content-type dimension scores (Blog/Video/Thumbnail) are NOT
 *    inputs to this formula.
 */
export type CategoryScores = Readonly<Record<ScoreCategory, number>>;

export function computeOverallContentScore(categoryScores: CategoryScores): number {
  let sum = 0;
  for (const category of SCORE_CATEGORIES) {
    const value = categoryScores[category];
    assertInScoreRange(`category score "${category}"`, value);
    sum += value;
  }
  return roundScore(sum / SCORE_CATEGORIES.length);
}
