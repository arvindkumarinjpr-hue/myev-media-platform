/**
 * Module 8 Phase 8.2 — deterministic, transparent relevance scoring.
 *
 * Pure function, no Prisma/DB access — the service gathers every raw
 * signal first (DB reads only), then hands primitives here. Same input
 * always produces the same score. No AI, no embeddings, no black box:
 * every persisted recommendation carries the full factor breakdown this
 * function returns as its `evidence`.
 *
 * Factors implemented are exactly the ones repository evidence supports
 * (Module 8 Architecture Checkpoint Correction §D — verified relationships
 * only). Anchor-fit is NOT implemented: there is no way to compute it
 * without the Phase 8.3 anchor engine choosing a candidate anchor first.
 */

export interface ScoringFactor {
  id: string;
  label: string;
  rawValue: unknown;
  normalizedScore: number; // 0-100
  weight: number;
  contribution: number; // normalizedScore * weight
  reason: string;
}

export interface CandidateEvidence {
  overallScore: number; // 0-100, clamped
  totalWeight: number;
  factors: ScoringFactor[];
  discoveryMethod: DiscoveryMethod;
}

export type DiscoveryMethod = "cluster" | "keyword-cluster" | "kp-keyword" | "token-fallback";

export interface CandidateScoringInput {
  discoveryMethod: DiscoveryMethod;
  sharedSeries: boolean;
  sharedSeriesHasTopicCluster: boolean;
  sharedKeywordClusterTerms: string[];
  sourceKeywordClusterTermCount: number;
  targetKeywordClusterTermCount: number;
  sharedKpKeywords: string[];
  sourceKpKeywordMentionCount: number;
  sourceTokens: string[];
  targetTokens: string[];
  targetUpdatedAt: Date;
  now: Date;
  /** Latest ContentScore.overallScore for the target, or null if none exists yet — never triggers scoring. */
  targetAuthorityScore: number | null;
  sourceRelativeLinkCount: number;
}

// Weights — implementation defaults, not frozen product policy (same
// status as contentScoring.passThreshold). Total weight = 12; every
// factor's contribution is normalizedScore * weight, and the overall
// score is the weighted mean, clamped 0-100.
const WEIGHTS = {
  clusterProximity: 3,
  keywordClusterOverlap: 3,
  kpKeywordCoverage: 2,
  tokenOverlap: 1,
  targetFreshness: 1,
  targetAuthority: 1,
  linkHeadroom: 1,
} as const;

// Neutral default when no ContentScore exists yet for the target — a
// content item that has simply never been scored is treated as
// "unknown," not "bad." Documented, not silently applied.
const NEUTRAL_AUTHORITY_SCORE = 50;

// Freshness decay window, in days — 100 at or under, 0 at or over.
const FRESHNESS_FULL_SCORE_DAYS = 30;
const FRESHNESS_ZERO_SCORE_DAYS = 180;

// Link-density headroom — 100 at zero existing relative links in the
// source body, 0 at or above this count.
const LINK_HEADROOM_ZERO_AT_COUNT = 8;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value);
}

function ratioScore(sharedCount: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return clamp(round((sharedCount / denominator) * 100), 0, 100);
}

function jaccardScore(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const term of setA) if (setB.has(term)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : clamp(round((intersection / union) * 100), 0, 100);
}

export function scoreCandidate(input: CandidateScoringInput): CandidateEvidence {
  const factors: ScoringFactor[] = [];

  // 1. Cluster proximity — the one real structural relationship in the
  // schema: shared ContentSeries membership, enriched if that series has
  // been promoted to a TopicCluster (Correction §D/§E).
  const clusterProximityScore = input.sharedSeries ? (input.sharedSeriesHasTopicCluster ? 100 : 70) : 0;
  factors.push({
    id: "cluster-proximity",
    label: "Topic/cluster proximity",
    rawValue: { sharedSeries: input.sharedSeries, sharedSeriesHasTopicCluster: input.sharedSeriesHasTopicCluster },
    normalizedScore: clusterProximityScore,
    weight: WEIGHTS.clusterProximity,
    contribution: clusterProximityScore * WEIGHTS.clusterProximity,
    reason: input.sharedSeriesHasTopicCluster
      ? "Source and target share a Content Series that has been promoted to a Topic Cluster."
      : input.sharedSeries
        ? "Source and target share a Content Series (not yet promoted to a Topic Cluster)."
        : "Source and target do not share a Content Series.",
  });

  // 2. Keyword-cluster overlap — via each item's own series' Topic
  // Cluster's Keyword Cluster members, independent of whether the two
  // items share the SAME series.
  const keywordClusterScore = ratioScore(input.sharedKeywordClusterTerms.length, Math.min(input.sourceKeywordClusterTermCount, input.targetKeywordClusterTermCount) || 0);
  factors.push({
    id: "keyword-cluster-overlap",
    label: "Keyword-cluster overlap",
    rawValue: { sharedTerms: input.sharedKeywordClusterTerms.slice(0, 10), sourceTermCount: input.sourceKeywordClusterTermCount, targetTermCount: input.targetKeywordClusterTermCount },
    normalizedScore: keywordClusterScore,
    weight: WEIGHTS.keywordClusterOverlap,
    contribution: keywordClusterScore * WEIGHTS.keywordClusterOverlap,
    reason:
      input.sharedKeywordClusterTerms.length > 0
        ? `${input.sharedKeywordClusterTerms.length} shared keyword-cluster term(s): ${input.sharedKeywordClusterTerms.slice(0, 5).join(", ")}.`
        : "No shared keyword-cluster terms (one or both items have no Topic Cluster keyword data).",
  });

  // 3. Knowledge Pack SEO keyword coverage — both items substantively
  // discuss the same workspace-defined target keywords.
  const kpKeywordScore = ratioScore(input.sharedKpKeywords.length, input.sourceKpKeywordMentionCount);
  factors.push({
    id: "kp-keyword-coverage",
    label: "Knowledge Pack keyword coverage",
    rawValue: { sharedKeywords: input.sharedKpKeywords.slice(0, 10), sourceMentionCount: input.sourceKpKeywordMentionCount },
    normalizedScore: kpKeywordScore,
    weight: WEIGHTS.kpKeywordCoverage,
    contribution: kpKeywordScore * WEIGHTS.kpKeywordCoverage,
    reason:
      input.sharedKpKeywords.length > 0
        ? `Both items mention ${input.sharedKpKeywords.length} shared Knowledge Pack keyword(s): ${input.sharedKpKeywords.slice(0, 5).join(", ")}.`
        : "No shared Knowledge Pack keywords found in both items' text (or no active Knowledge Pack keywords).",
  });

  // 4. Title/content token overlap — the documented deterministic
  // fallback signal (also usable standalone when no candidates surface
  // via signals 1-3 — see the discovery service).
  const tokenScore = jaccardScore(input.sourceTokens, input.targetTokens);
  factors.push({
    id: "token-overlap",
    label: "Title/content token overlap",
    rawValue: { sourceTokenCount: input.sourceTokens.length, targetTokenCount: input.targetTokens.length },
    normalizedScore: tokenScore,
    weight: WEIGHTS.tokenOverlap,
    contribution: tokenScore * WEIGHTS.tokenOverlap,
    reason: `Jaccard token overlap between source and target title/body text: ${tokenScore}%.`,
  });

  // 5. Target freshness — linear decay from 30 to 180 days since the
  // target's last update.
  const ageDays = Math.max(0, (input.now.getTime() - input.targetUpdatedAt.getTime()) / (1000 * 60 * 60 * 24));
  const freshnessScore =
    ageDays <= FRESHNESS_FULL_SCORE_DAYS
      ? 100
      : ageDays >= FRESHNESS_ZERO_SCORE_DAYS
        ? 0
        : clamp(round(100 - ((ageDays - FRESHNESS_FULL_SCORE_DAYS) / (FRESHNESS_ZERO_SCORE_DAYS - FRESHNESS_FULL_SCORE_DAYS)) * 100), 0, 100);
  factors.push({
    id: "target-freshness",
    label: "Target freshness",
    rawValue: { ageDays: round(ageDays) },
    normalizedScore: freshnessScore,
    weight: WEIGHTS.targetFreshness,
    contribution: freshnessScore * WEIGHTS.targetFreshness,
    reason: `Target was last updated ${round(ageDays)} day(s) ago.`,
  });

  // 6. Target authority — latest persisted ContentScore.overallScore, or
  // a documented neutral default if none exists. Never triggers scoring.
  const authorityScore = input.targetAuthorityScore ?? NEUTRAL_AUTHORITY_SCORE;
  factors.push({
    id: "target-authority",
    label: "Target authority (latest content score)",
    rawValue: { targetAuthorityScore: input.targetAuthorityScore },
    normalizedScore: clamp(authorityScore, 0, 100),
    weight: WEIGHTS.targetAuthority,
    contribution: clamp(authorityScore, 0, 100) * WEIGHTS.targetAuthority,
    reason: input.targetAuthorityScore === null ? `Target has no scored content_scores row yet — neutral default (${NEUTRAL_AUTHORITY_SCORE}) applied.` : `Target's latest overall content score is ${input.targetAuthorityScore}.`,
  });

  // 7. Existing-link density headroom — the more relative links already
  // in the source body, the less "room" a new one has (soft signal; the
  // hard per-run cap lives in config, not here).
  const headroomScore = clamp(round(100 - (input.sourceRelativeLinkCount / LINK_HEADROOM_ZERO_AT_COUNT) * 100), 0, 100);
  factors.push({
    id: "link-density-headroom",
    label: "Existing-link density headroom",
    rawValue: { sourceRelativeLinkCount: input.sourceRelativeLinkCount },
    normalizedScore: headroomScore,
    weight: WEIGHTS.linkHeadroom,
    contribution: headroomScore * WEIGHTS.linkHeadroom,
    reason: `Source body already contains ${input.sourceRelativeLinkCount} relative link(s).`,
  });

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const overallScore = clamp(round(factors.reduce((sum, f) => sum + f.contribution, 0) / totalWeight), 0, 100);

  return { overallScore, totalWeight, factors, discoveryMethod: input.discoveryMethod };
}

const DISCOVERY_METHOD_LABELS: Record<DiscoveryMethod, string> = {
  cluster: "Same content series / topic cluster",
  "keyword-cluster": "Shared keyword-cluster topic",
  "kp-keyword": "Shared Knowledge Pack keywords",
  "token-fallback": "Related by shared terms",
};

/**
 * Module 8 Phase 8.4 — a short, deterministic, human-readable summary of
 * WHY a recommendation was made, derived from its own structured
 * evidence. Used only for the Module 6 Blog pipeline's lightweight
 * InternalLinkingSuggestion.reason snapshot (never the full evidence
 * JSON — that stays in internal_links, per the pipeline seam's own
 * frozen "lightweight snapshot" contract).
 */
export function summarizeEvidenceReason(evidence: CandidateEvidence): string {
  return `${DISCOVERY_METHOD_LABELS[evidence.discoveryMethod]} (relevance ${evidence.overallScore})`;
}
