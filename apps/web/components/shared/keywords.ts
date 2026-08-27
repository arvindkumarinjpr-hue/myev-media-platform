import type { KeywordClusterMember, PersistedKeyword } from "../../lib/types";

/** One shape for both Research's in-flight keyword members and Topic Cluster's persisted keywords. */
export interface NormalizedKeyword {
  term: string;
  intent: "informational" | "transactional" | "navigational" | "unknown";
  opportunityScore: number;
  rationale: string;
}

export const INTENT_LABEL: Record<NormalizedKeyword["intent"], string> = {
  informational: "Informational",
  transactional: "Transactional",
  navigational: "Navigational",
  unknown: "Unknown",
};

function normalizeIntent(raw: string): NormalizedKeyword["intent"] {
  const v = raw.toLowerCase();
  if (v === "informational" || v === "transactional" || v === "navigational") return v;
  return "unknown";
}

/** Research `KeywordClusterMember` → NormalizedKeyword. */
export function fromResearchKeyword(k: KeywordClusterMember): NormalizedKeyword {
  return { term: k.keyword, intent: normalizeIntent(k.intent), opportunityScore: k.opportunityScore, rationale: k.rationale };
}

/** Topic Cluster `PersistedKeyword` → NormalizedKeyword. */
export function fromPersistedKeyword(k: PersistedKeyword): NormalizedKeyword {
  return { term: k.term, intent: normalizeIntent(k.searchIntent), opportunityScore: k.opportunityScore, rationale: k.rationale };
}

export interface NormalizedCluster {
  title: string;
  primary: NormalizedKeyword[];
  secondary: NormalizedKeyword[];
}
