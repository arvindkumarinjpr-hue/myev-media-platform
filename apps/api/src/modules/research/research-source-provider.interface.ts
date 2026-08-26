/**
 * Module 4 Phase 4.1 — the provider-neutral boundary FR-RES-002's own
 * "Source URL reachability check before inclusion" runs through. Never
 * a live web/SERP search — the candidate URLs always come from the
 * workspace's own Knowledge Pack Trusted Sources list (Module 2); this
 * boundary only checks whether each configured URL is currently
 * reachable, exactly like the FRD's own AC requires, before the
 * Research Agent is allowed to cite it.
 */
export interface CandidateSource {
  url: string;
  sourceType: string;
}

export interface CheckedSource extends CandidateSource {
  reachable: boolean;
}

export const RESEARCH_SOURCE_PROVIDER = Symbol("RESEARCH_SOURCE_PROVIDER");

export interface ResearchSourceProvider {
  checkReachable(sources: CandidateSource[]): Promise<CheckedSource[]>;
}
