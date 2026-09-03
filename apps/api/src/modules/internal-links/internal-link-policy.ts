/**
 * Module 8 Phase 8.3 — typed parser/validator for the already-existing,
 * already-migrated `KnowledgePackSeoRule.internalLinkingPolicy` JSONB
 * column (`@default("{}")`, currently unused anywhere in the codebase —
 * verified by grep before this file was written). No migration: the
 * column already exists and is already JSON.
 *
 * Tolerant by construction: malformed, partial, or entirely absent
 * policy JSON must never crash generation — every key falls back to a
 * safe, documented default independently of every other key.
 */

export interface InternalLinkingPolicy {
  /**
   * Parsed and validated, but NOT YET wired into Module 8 behavior this
   * phase — Phase 8.2's own AppConfig.internalLinking.maxRecommendationsPerRun
   * (a global env default) remains the authoritative per-run cap.
   * Unifying a per-workspace override into that decision is left to a
   * future phase's explicit choice, not silently done here (scope: "only
   * policy needed for Module 8 anchor/recommendation behavior").
   */
  maxLinksPerArticle: number;
  /** ACTIVELY USED — see internal-link-anchor.service.ts's exact-match-repeat guard. */
  maxExactMatchAnchorRepeats: number;
  /** ACTIVELY USED — filtered out of every discovery candidate pool. Public content-item ids. */
  excludedContentItemIds: string[];
  /** ACTIVELY USED as an additional floor (max of this and the AppConfig default) when present. Null = no override. */
  minRelevanceScore: number | null;
}

export const DEFAULT_INTERNAL_LINKING_POLICY: InternalLinkingPolicy = {
  maxLinksPerArticle: 8,
  maxExactMatchAnchorRepeats: 2,
  excludedContentItemIds: [],
  minRelevanceScore: null,
};

function positiveIntOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** Never throws — an unrecognized shape simply yields the full default policy. */
export function resolveInternalLinkingPolicy(raw: unknown): InternalLinkingPolicy {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...DEFAULT_INTERNAL_LINKING_POLICY };
  const obj = raw as Record<string, unknown>;

  const excludedContentItemIds = Array.isArray(obj.excludedContentItemIds) ? obj.excludedContentItemIds.filter((v): v is string => typeof v === "string" && v.trim().length > 0) : DEFAULT_INTERNAL_LINKING_POLICY.excludedContentItemIds;

  const minRelevanceScore = typeof obj.minRelevanceScore === "number" && obj.minRelevanceScore >= 0 && obj.minRelevanceScore <= 100 ? obj.minRelevanceScore : DEFAULT_INTERNAL_LINKING_POLICY.minRelevanceScore;

  return {
    maxLinksPerArticle: positiveIntOr(obj.maxLinksPerArticle, DEFAULT_INTERNAL_LINKING_POLICY.maxLinksPerArticle),
    maxExactMatchAnchorRepeats: positiveIntOr(obj.maxExactMatchAnchorRepeats, DEFAULT_INTERNAL_LINKING_POLICY.maxExactMatchAnchorRepeats),
    excludedContentItemIds,
    minRelevanceScore,
  };
}
