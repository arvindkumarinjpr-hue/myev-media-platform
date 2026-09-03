import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { readPipelineState } from "../blog/blog-pipeline-state";
import { buildCandidates, extractDomainToken, validateAnchorStructure, type AnchorSelectionSource } from "./internal-link-anchor";
import { resolveInternalLinkingPolicy } from "./internal-link-policy";

export const ANCHOR_ENGINE_VERSION = 1;

export interface RejectedAnchorCandidate {
  phrase: string;
  source: AnchorSelectionSource;
  reason: string;
}

export interface AnchorSelectionEvidence {
  selectedAnchor: string;
  selectionSource: AnchorSelectionSource;
  candidateCount: number;
  rejectedCandidates: RejectedAnchorCandidate[];
  policyApplied: { maxExactMatchAnchorRepeats: number };
  fallbackUsed: boolean;
  engineVersion: number;
}

/**
 * Module 8 Phase 8.3 — Anchor Recommendation Engine (deterministic).
 *
 * Reads: target's already-persisted Blog pipeline Brief output (via
 * Module 6's own exported, pure, read-only readPipelineState() — never
 * a modification, and returns null safely for a plain, non-pipeline item
 * exactly the same way this service needs it to), the active Knowledge
 * Pack's brand terminology + competitor domains + internalLinkingPolicy,
 * and this target's own exact-match anchor history. No AI, no provider
 * call, no content mutation.
 */
@Injectable()
export class InternalLinkAnchorService {
  constructor(private readonly prisma: PrismaService) {}

  async selectAnchor(workspaceId: string, sourceText: string, target: { id: string; title: string }): Promise<AnchorSelectionEvidence> {
    const [targetPrimaryKeyword, blockedTerms, policy] = await Promise.all([this.loadTargetPrimaryKeyword(target.id), this.loadBlockedTerms(workspaceId), this.loadPolicy(workspaceId)]);

    const candidates = buildCandidates(sourceText, target.title, targetPrimaryKeyword);
    const rejectedCandidates: RejectedAnchorCandidate[] = [];

    for (const candidate of candidates) {
      const isFallback = candidate.source === "target-title-fallback";

      // The target's own title is never subject to brand/competitor
      // blocking or structural rejection — it is the target's real,
      // truthful identifier, not a keyword-stuffing risk, and Phase 8.2
      // already unconditionally seeds it (this engine must never regress
      // that guarantee — see Phase 8.3 architecture §C/§L).
      if (!isFallback) {
        const structural = validateAnchorStructure(candidate.phrase, blockedTerms);
        if (!structural.valid) {
          rejectedCandidates.push({ ...candidate, reason: structural.reason! });
          continue;
        }
        const repeatCount = await this.countExactMatchHistory(workspaceId, target.id, candidate.phrase);
        if (repeatCount >= policy.maxExactMatchAnchorRepeats) {
          rejectedCandidates.push({ ...candidate, reason: "exact-match-repeat-limit" });
          continue;
        }
      }

      return {
        selectedAnchor: candidate.phrase,
        selectionSource: candidate.source,
        candidateCount: candidates.length,
        rejectedCandidates,
        policyApplied: { maxExactMatchAnchorRepeats: policy.maxExactMatchAnchorRepeats },
        fallbackUsed: isFallback,
        engineVersion: ANCHOR_ENGINE_VERSION,
      };
    }

    // Unreachable in practice — buildCandidates() always appends the
    // unconditionally-accepted title fallback last — but keeps this
    // function total rather than relying on that invariant alone.
    const fallback = candidates[candidates.length - 1];
    return {
      selectedAnchor: fallback.phrase,
      selectionSource: fallback.source,
      candidateCount: candidates.length,
      rejectedCandidates,
      policyApplied: { maxExactMatchAnchorRepeats: policy.maxExactMatchAnchorRepeats },
      fallbackUsed: true,
      engineVersion: ANCHOR_ENGINE_VERSION,
    };
  }

  /** The target's own persisted Blog-pipeline Brief output, when it went through one — never triggers AI, never re-reads a private Module 6 internal (readPipelineState is an exported pure helper). */
  private async loadTargetPrimaryKeyword(targetContentItemId: string): Promise<string | null> {
    const item = await this.prisma.contentItem.findUnique({ where: { id: targetContentItemId }, select: { metadata: true } });
    const state = readPipelineState(item?.metadata ?? null);
    return state?.brief.artifact?.primaryKeyword ?? null;
  }

  /** Same terminology-flattening convention as blog-pipeline.service.ts's own loadBrandTerms() (independently implemented — that method is private) + competitor domain tokens. */
  private async loadBlockedTerms(workspaceId: string): Promise<string[]> {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: { brandGuidelines: { select: { terminology: true } }, competitors: { select: { domain: true } } },
    });
    if (!pack) return [];
    const terms = new Set<string>();
    for (const bg of pack.brandGuidelines) {
      const t = bg.terminology;
      if (t && typeof t === "object" && !Array.isArray(t)) {
        for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
          if (typeof k === "string" && k.trim()) terms.add(k.trim().toLowerCase());
          if (typeof v === "string" && v.trim()) terms.add(v.trim().toLowerCase());
        }
      }
    }
    for (const c of pack.competitors) {
      const token = extractDomainToken(c.domain);
      if (token) terms.add(token);
    }
    return [...terms];
  }

  private async loadPolicy(workspaceId: string) {
    const pack = await this.prisma.knowledgePack.findFirst({
      where: { workspaceId, status: "ACTIVE", deletedAt: null },
      select: { seoRules: { select: { internalLinkingPolicy: true }, take: 1 } },
    });
    return resolveInternalLinkingPolicy(pack?.seoRules[0]?.internalLinkingPolicy ?? null);
  }

  /** Active/accepted history only — REJECTED/STALE rows never poison future selection (Phase 8.3 architecture §I), and ACCEPTED rows are read-only here, never mutated. */
  private async countExactMatchHistory(workspaceId: string, targetContentItemId: string, phrase: string): Promise<number> {
    return this.prisma.internalLink.count({
      where: { workspaceId, targetContentItemId, status: { in: ["GENERATED", "ACCEPTED"] }, anchorText: { equals: phrase, mode: "insensitive" } },
    });
  }
}
