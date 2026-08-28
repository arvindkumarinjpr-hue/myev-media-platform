/**
 * Module 6 Phase 6.1 — the ONLY place a "passing score" threshold is
 * read and applied.
 *
 * FR-BLOG-006 / Blog Automation Engine Quality Gate #6 require a content
 * score to pass a threshold, but no frozen document gives the number
 * (see AppConfig.contentScoring.passThreshold's comment). Keeping the
 * comparison here — a two-line pure helper the service calls, fed by
 * config — means:
 *
 *   - the shared scoring domain (@myev/shared) never mentions a
 *     threshold;
 *   - no service or test hardcodes "70";
 *   - swapping the default, or making it per-workspace later, is a
 *     one-line config change plus this helper.
 *
 * Nothing else about a ScoreResult changes based on the threshold — it
 * is purely a downstream gate decision, not part of scoring.
 */

export interface ThresholdOutcome {
  /** The configured pass threshold this decision used. */
  readonly threshold: number;
  /** overall >= threshold. */
  readonly passed: boolean;
}

export function evaluateThreshold(overallScore: number, threshold: number): ThresholdOutcome {
  return { threshold, passed: overallScore >= threshold };
}
