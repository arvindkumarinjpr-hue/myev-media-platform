import type { ScoreCategory } from "./score-category";

/**
 * Module 6 Phase 6.1 — an actionable improvement item.
 *
 * CONTENT_SCORING_ENGINE_V1.0.md, Reporting: the dashboard includes an
 * "Improvement checklist"; AI Recommendations lists the *kinds* of
 * suggestion the engine should make ("Better title", "Missing sections",
 * "Internal linking opportunities", …).
 *
 * Phase 6.1 note: these are produced DETERMINISTICALLY from which
 * factors scored low — there is no AI provider call in this phase. A
 * later phase's Blog pipeline may enrich the message text via an
 * AI-assisted pass; the shape here does not change when it does.
 */
export const RECOMMENDATION_PRIORITIES = ["HIGH", "MEDIUM", "LOW"] as const;
export type RecommendationPriority = (typeof RECOMMENDATION_PRIORITIES)[number];

export function recommendationPriorityOrder(priority: RecommendationPriority): number {
  return RECOMMENDATION_PRIORITIES.indexOf(priority);
}

export interface ImprovementRecommendation {
  /** Stable, kebab-case identifier — unique within one ScoreResult. */
  readonly id: string;

  /** How much this matters. HIGH first in the serialized order. */
  readonly priority: RecommendationPriority;

  /** The category this improvement would most raise, or null when it is
   * dimension-scoped / cross-cutting. */
  readonly category: ScoreCategory | null;

  /** Plain-language, imperative: "Add a meta description of 140–160
   * characters." */
  readonly message: string;

  /** The `ScoringFactor.id` that triggered this, when there is exactly
   * one. Lets the UI attach the recommendation to the right checklist
   * row. */
  readonly relatedFactorId?: string;
}
