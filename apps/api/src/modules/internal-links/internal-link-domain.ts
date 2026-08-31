import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import type { ContentItemStatus, InternalLinkStatus } from "../../../generated/prisma";
import { INTERNAL_LINK_ERRORS } from "./internal-link.errors";

/**
 * Module 8 Phase 8.1 — Internal Linking Engine, domain invariants.
 *
 * Pure functions, no Prisma/DB access — independently unit-testable
 * (same pattern as blog-pipeline-state.ts's assertEditable-style
 * helpers). Callers (InternalLinksService) resolve the actual
 * ContentItem rows first and pass in primitives here.
 *
 * Scope is deliberately narrow to what Phase 8.1 owns: self-link
 * rejection, source/target eligibility (Module 8 Architecture Checkpoint
 * Correction §3, verified against the real ContentItemStatus enum and
 * EDITABLE_STATUSES), relevance-score range, and lifecycle-transition
 * validity (D9). Candidate discovery, scoring, and anchor generation are
 * Phase 8.2/8.3 — not implemented here.
 */

// Mirrors Module 1E's own EDITABLE_STATUSES (blog-pipeline.service.ts) —
// the exact statuses in which the Blog pipeline itself is already
// permitted to run, and the only statuses a human is actively drafting
// in, so the only statuses a link recommendation could ever be
// meaningfully surfaced against as a *source*.
const ELIGIBLE_SOURCE_STATUSES: ContentItemStatus[] = ["DRAFT", "IN_PROGRESS"];

// The highest status any content item can actually reach in the current
// architecture (RENDERING/FAILED/SCHEDULED/PUBLISHED are reserved/unused
// by any current Module 1E code path — never treated as reachable here).
const ELIGIBLE_TARGET_STATUSES: ContentItemStatus[] = ["APPROVED"];

// D9 — GENERATED -> ACCEPTED | REJECTED | STALE; ACCEPTED -> STALE.
// REJECTED and STALE are both terminal for that row (a fresh
// recommendation for the same pair is always a NEW row — see the
// partial unique index). No ACCEPTED -> REJECTED, no resurrection.
const ALLOWED_TRANSITIONS: Record<InternalLinkStatus, InternalLinkStatus[]> = {
  GENERATED: ["ACCEPTED", "REJECTED", "STALE"],
  ACCEPTED: ["STALE"],
  REJECTED: [],
  STALE: [],
};

export function assertNoSelfLink(sourceContentItemId: string, targetContentItemId: string): void {
  if (sourceContentItemId === targetContentItemId) {
    throw new UnprocessableEntityException({
      code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_SELF_LINK_NOT_ALLOWED,
      message: "A content item cannot be recommended as an internal link to itself.",
    });
  }
}

export function assertSourceEligible(status: ContentItemStatus, deletedAt: Date | null): void {
  if (deletedAt !== null || !ELIGIBLE_SOURCE_STATUSES.includes(status)) {
    throw new UnprocessableEntityException({
      code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_SOURCE_NOT_ELIGIBLE,
      message: `Source content item is "${status}"${deletedAt !== null ? " (deleted)" : ""} — internal-link recommendations require DRAFT or IN_PROGRESS.`,
    });
  }
}

export function assertTargetEligible(status: ContentItemStatus, deletedAt: Date | null): void {
  if (deletedAt !== null || !ELIGIBLE_TARGET_STATUSES.includes(status)) {
    throw new UnprocessableEntityException({
      code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_TARGET_NOT_ELIGIBLE,
      message: `Target content item is "${status}"${deletedAt !== null ? " (deleted)" : ""} — internal-link targets require APPROVED.`,
    });
  }
}

export function assertValidRelevanceScore(score: number): void {
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    throw new UnprocessableEntityException({
      code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_INVALID_RELEVANCE_SCORE,
      message: "relevanceScore must be an integer between 0 and 100.",
    });
  }
}

export function assertValidTransition(from: InternalLinkStatus, to: InternalLinkStatus): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    throw new ConflictException({
      code: INTERNAL_LINK_ERRORS.INTERNAL_LINK_INVALID_TRANSITION,
      message: `Cannot transition an internal-link recommendation from "${from}" to "${to}".`,
    });
  }
}
