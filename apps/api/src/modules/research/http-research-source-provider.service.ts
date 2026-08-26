import { Injectable, Logger } from "@nestjs/common";
import type { CandidateSource, CheckedSource, ResearchSourceProvider } from "./research-source-provider.interface";

const REACHABILITY_TIMEOUT_MS = 5_000;

/**
 * Module 4 Phase 4.1 — the real ResearchSourceProvider. A source counts
 * as reachable when it returns any response with status < 500 (the
 * server actually answered — a 404/405 still proves reachability even
 * if the exact resource moved, since some servers reject a plain HEAD);
 * a network error, timeout, or 5xx counts as unreachable. Per
 * FR-RES-002's own error condition, a single unreachable source is
 * never a hard failure here — this only classifies, the caller decides
 * what to do with the result (exclude + log a warning).
 */
@Injectable()
export class HttpResearchSourceProvider implements ResearchSourceProvider {
  private readonly logger = new Logger(HttpResearchSourceProvider.name);

  async checkReachable(sources: CandidateSource[]): Promise<CheckedSource[]> {
    return Promise.all(sources.map((source) => this.checkOne(source)));
  }

  private async checkOne(source: CandidateSource): Promise<CheckedSource> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
    try {
      const res = await fetch(source.url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
      return { ...source, reachable: res.status < 500 };
    } catch (err) {
      this.logger.warn(`Research source unreachable, excluding: ${source.url} (${err instanceof Error ? err.message : "unknown error"})`);
      return { ...source, reachable: false };
    } finally {
      clearTimeout(timeout);
    }
  }
}
