/**
 * Module 6 Phase 6.1 — Content Scoring Engine (shared foundation).
 *
 * The five UNIVERSAL score categories, verbatim from
 * CONTENT_SCORING_ENGINE_V1.0.md's Composite Score formula:
 *
 *   SEO + Viral + Quality + Engagement + Business → Overall Content Score
 *
 * These are the only inputs to the frozen composite formula. The
 * content-type-specific *dimensions* the same spec also lists (Blog
 * Score, Video Score, Thumbnail Score) are NOT categories and NOT part
 * of this formula — a dimension carries its own separately-named score
 * plus contributions into these five categories. See
 * `content-dimension.ts`.
 *
 * The array order is the canonical ordering used everywhere a category
 * list/record is serialized (see `serialization.ts`) — do not reorder.
 */
export const SCORE_CATEGORIES = ["SEO", "VIRAL", "QUALITY", "ENGAGEMENT", "BUSINESS"] as const;

export type ScoreCategory = (typeof SCORE_CATEGORIES)[number];

/** Human-facing label for each category — display only, never a key. */
export const SCORE_CATEGORY_LABELS: Readonly<Record<ScoreCategory, string>> = {
  SEO: "SEO",
  VIRAL: "Viral",
  QUALITY: "Content Quality",
  ENGAGEMENT: "Engagement",
  BUSINESS: "Business",
};

export function isScoreCategory(value: unknown): value is ScoreCategory {
  return typeof value === "string" && (SCORE_CATEGORIES as readonly string[]).includes(value);
}

/** Stable index used for deterministic ordering of category-keyed data. */
export function scoreCategoryOrder(category: ScoreCategory): number {
  return SCORE_CATEGORIES.indexOf(category);
}
