import type { ContentDimension, DimensionEvaluation } from "../content-dimension";
import { SCORE_CATEGORIES } from "../score-category";
import type { ScoringFactor } from "../scoring-factor";
import type { ScoringInput } from "../scoring-input";

/**
 * Module 6 Phase 6.1 — a deliberately non-Blog, non-Video, non-Thumbnail
 * scoring dimension used ONLY by the type-agnosticism gate tests
 * (MODULE_ROADMAP_V1.0.md §11).
 *
 * It proves a brand-new content type can be scored end-to-end THROUGH
 * the public contract — registry + engine — without touching the engine,
 * the registry, or the Blog dimension. If Module 7 could not add
 * Video/Thumbnail this cleanly, this test would be the first to break.
 *
 * Not exported from the package barrel — test-support code, same status
 * as `test-agent.ts` in the agent framework.
 */
export function makeSyntheticDimension(overrides: Partial<Pick<ContentDimension, "name" | "version" | "appliesTo">> = {}): ContentDimension {
  return {
    name: overrides.name ?? "synthetic",
    version: overrides.version ?? 1,
    appliesTo: overrides.appliesTo ?? ["PODCAST"],
    dimensionScoreLabel: "Synthetic Score",
    purpose: "Test-only dimension for the §11 type-agnosticism gate.",
    evaluate(input: ScoringInput): DimensionEvaluation {
      // One trivially-deterministic factor per universal category, plus a
      // dimension score — the minimum a valid dimension must produce.
      const base = Math.min(100, (input.bodyText ?? "").length);
      const categoryFactors: ScoringFactor[] = SCORE_CATEGORIES.map((category, i) => ({
        id: `synthetic-${category.toLowerCase()}`,
        category,
        label: `Synthetic ${category}`,
        value: Math.min(100, base + i),
        weight: 1,
        reason: `Synthetic deterministic factor for ${category}.`,
      }));
      return {
        categoryFactors,
        dimensionScore: Math.min(100, base),
        dimensionFactors: [
          { id: "synthetic-dim-1", category: null, label: "Synthetic dimension factor", value: Math.min(100, base), weight: 1, reason: "Synthetic." },
        ],
        recommendations:
          base < 50
            ? [{ id: "synthetic-rec-1", priority: "LOW", category: null, message: "Add more content." }]
            : [],
      };
    },
  };
}
