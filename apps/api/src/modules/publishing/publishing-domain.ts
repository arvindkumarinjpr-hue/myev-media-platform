import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import type { ContentItemStatus, ContentType, PublicationTargetStatus, VideoRenderJobStatus } from "../../../generated/prisma";
import { PUBLISHING_ERRORS } from "./publishing.errors";

/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain
 * invariants.
 *
 * Pure functions, no Prisma/DB access — independently unit-testable, same
 * pattern as internal-link-domain.ts's assert*Eligible/assertValidTransition
 * helpers. Callers resolve the actual ContentItem/VideoRenderJob rows
 * first and pass in primitives here; these functions never mutate
 * anything and never call out to another module.
 *
 * Scope is deliberately narrow to what Phase 9.1 owns: content publish
 * eligibility and PublicationTarget lifecycle-transition validity. No
 * provider/worker/scheduling/OAuth code exists yet — those are later
 * phases (Architecture Checkpoint §28).
 */

// The only ContentItemStatus a publish request may ever act on — mirrors
// InternalLink's own ELIGIBLE_TARGET_STATUSES precedent exactly (the
// highest status any content item can actually reach today; RENDERING/
// FAILED/SCHEDULED/PUBLISHED remain reserved/unused by any Module 6/7
// code path, per the Architecture Checkpoint's own repository-reality
// finding).
const ELIGIBLE_CONTENT_STATUSES: ContentItemStatus[] = ["APPROVED"];

/**
 * Blog eligibility is exactly `assertTargetEligible`'s own rule from
 * Module 8 (APPROVED, not deleted). Video eligibility additionally
 * requires a COMPLETED render job. This function deliberately does NOT
 * re-derive Module 7's own render-currentness hash check (scriptVersionHash
 * / sceneAssetFingerprint) — that lives deep inside Module 7's own
 * pipeline state and is out of scope for a Phase 9.1 domain primitive;
 * a later phase resolving a real artifact for upload is where that full
 * currentness check belongs. This primitive checks only the two facts
 * genuinely visible from ContentItem/VideoRenderJob rows alone: approved,
 * and (for VIDEO) render-complete.
 *
 * Never mutates anything — Publishing must never alter Blog body, alter
 * Video render output, apply Module 8 recommendations, or downgrade
 * editorial approval (Architecture Checkpoint §25/Part L); a read-only
 * eligibility check satisfies that by construction.
 */
export function assertContentPublishEligible(input: {
  contentType: ContentType;
  status: ContentItemStatus;
  deletedAt: Date | null;
  /** Required context only when contentType === "VIDEO"; ignored otherwise. */
  latestVideoRenderJobStatus?: VideoRenderJobStatus | null;
}): void {
  if (input.deletedAt !== null || !ELIGIBLE_CONTENT_STATUSES.includes(input.status)) {
    throw new UnprocessableEntityException({
      code: PUBLISHING_ERRORS.PUBLISHING_CONTENT_NOT_ELIGIBLE,
      message: `Content item is "${input.status}"${input.deletedAt !== null ? " (deleted)" : ""} — publishing requires APPROVED, non-deleted content.`,
    });
  }
  if (input.contentType === "VIDEO" && input.latestVideoRenderJobStatus !== "COMPLETED") {
    throw new UnprocessableEntityException({
      code: PUBLISHING_ERRORS.PUBLISHING_VIDEO_RENDER_NOT_READY,
      message: `Video content requires a COMPLETED render job before publishing (found "${input.latestVideoRenderJobStatus ?? "none"}").`,
    });
  }
}

// PENDING -> SCHEDULED | QUEUED | CANCELLED
// SCHEDULED -> QUEUED | CANCELLED
// QUEUED -> PUBLISHING | CANCELLED
// PUBLISHING -> PUBLISHED | FAILED
// FAILED -> QUEUED (an explicit, deliberate retry only) | CANCELLED
// PUBLISHED, CANCELLED -- both terminal, no further transition.
//
// FAILED never transitions back to PENDING: a silent reset would
// misrepresent a real prior attempt as though it never happened,
// destroying the exact history Part O requires PublishAttempt to
// preserve. A retry re-enters the live/QUEUED state explicitly, keeping
// its full attempt history intact on the same target row.
const ALLOWED_TARGET_TRANSITIONS: Record<PublicationTargetStatus, PublicationTargetStatus[]> = {
  PENDING: ["SCHEDULED", "QUEUED", "CANCELLED"],
  SCHEDULED: ["QUEUED", "CANCELLED"],
  QUEUED: ["PUBLISHING", "CANCELLED"],
  PUBLISHING: ["PUBLISHED", "FAILED"],
  FAILED: ["QUEUED", "CANCELLED"],
  PUBLISHED: [],
  CANCELLED: [],
};

export function assertPublicationTargetTransition(from: PublicationTargetStatus, to: PublicationTargetStatus): void {
  if (!ALLOWED_TARGET_TRANSITIONS[from].includes(to)) {
    throw new ConflictException({
      code: PUBLISHING_ERRORS.PUBLISHING_TARGET_INVALID_TRANSITION,
      message: `Cannot transition a publication target from "${from}" to "${to}".`,
    });
  }
}

// The statuses the live-target DB uniqueness invariant (see the Phase
// 9.1 migration's hand-written partial unique index on
// publication_targets) treats as "currently occupying" a (workspace,
// content item, channel account) slot. PUBLISHED/FAILED/CANCELLED are
// history, never blocking a later independent publish attempt to the
// same target — same "REJECTED/STALE are history, not live" precedent
// Module 8's own partial unique index established.
const LIVE_TARGET_STATUSES: PublicationTargetStatus[] = ["PENDING", "SCHEDULED", "QUEUED", "PUBLISHING"];

export function isPublicationTargetLive(status: PublicationTargetStatus): boolean {
  return LIVE_TARGET_STATUSES.includes(status);
}

export interface PublicationSummary {
  totalTargets: number;
  publishedCount: number;
  failedCount: number;
  cancelledCount: number;
  liveCount: number;
  /** True only when every target has reached PUBLISHED — never true while any target is FAILED, CANCELLED, or still live. */
  isFullyPublished: boolean;
  /** True when at least one target published and at least one target failed — the exact "never collapse partial failure into a false PUBLISHED state" case this function exists to make explicit. */
  hasPartialFailure: boolean;
  /** True once no target remains live — the point at which isFullyPublished/hasPartialFailure/a plain failure become the final word for this Publication. */
  isFullyTerminal: boolean;
}

/**
 * The one place a Publication's aggregate state is computed — always at
 * read time from its own PublicationTarget rows, never cached (Architecture
 * Checkpoint §13/Part K: Publication itself persists no status column at
 * all in Phase 9.1). Deliberately returns a structured summary rather
 * than a single collapsed enum, so a caller can never accidentally
 * render "PUBLISHED" for a Publication that actually has one FAILED
 * target sitting alongside three PUBLISHED ones.
 */
export function derivePublicationSummary(targetStatuses: PublicationTargetStatus[]): PublicationSummary {
  const publishedCount = targetStatuses.filter((s) => s === "PUBLISHED").length;
  const failedCount = targetStatuses.filter((s) => s === "FAILED").length;
  const cancelledCount = targetStatuses.filter((s) => s === "CANCELLED").length;
  const liveCount = targetStatuses.filter(isPublicationTargetLive).length;
  const totalTargets = targetStatuses.length;
  return {
    totalTargets,
    publishedCount,
    failedCount,
    cancelledCount,
    liveCount,
    isFullyPublished: totalTargets > 0 && publishedCount === totalTargets,
    hasPartialFailure: publishedCount > 0 && failedCount > 0,
    isFullyTerminal: liveCount === 0,
  };
}
