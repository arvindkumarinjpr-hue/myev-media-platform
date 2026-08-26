import type { CandidateSource, CheckedSource, ResearchSourceProvider } from "./research-source-provider.interface";

/**
 * Module 4 Phase 4.1 — a deterministic ResearchSourceProvider for tests,
 * mirroring @myev/shared's own FakeProvider precedent exactly: zero
 * network dependency, fully predictable per-instance behavior. Marks
 * every source reachable by default (mode: "all-reachable"), or every
 * source unreachable ("all-unreachable"), or reachable only for URLs
 * matching a caller-supplied predicate ("selective") — enough to prove
 * both the "cite only reachable sources" and "unreachable excluded,
 * warning logged, not a hard failure" behaviors deterministically.
 */
export type FakeResearchSourceProviderMode = "all-reachable" | "all-unreachable" | "selective";

export class FakeResearchSourceProvider implements ResearchSourceProvider {
  constructor(
    private readonly mode: FakeResearchSourceProviderMode = "all-reachable",
    private readonly reachablePredicate: (url: string) => boolean = () => true,
  ) {}

  async checkReachable(sources: CandidateSource[]): Promise<CheckedSource[]> {
    return sources.map((source) => ({
      ...source,
      reachable: this.mode === "all-reachable" ? true : this.mode === "all-unreachable" ? false : this.reachablePredicate(source.url),
    }));
  }
}
