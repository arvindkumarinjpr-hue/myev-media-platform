import { PublishingDomainError } from "./publishing-domain-error";
import type { PublicationTargetStatus, PublishingContentType, PublishingVideoRenderJobStatus } from "./publishing-types";

export const PUBLISHING_DOMAIN_ERROR_CODES = {
  PUBLISHING_CONTENT_NOT_ELIGIBLE: "PUBLISHING_CONTENT_NOT_ELIGIBLE",
  PUBLISHING_VIDEO_RENDER_NOT_READY: "PUBLISHING_VIDEO_RENDER_NOT_READY",
  PUBLISHING_TARGET_INVALID_TRANSITION: "PUBLISHING_TARGET_INVALID_TRANSITION",
} as const;

/**
 * Module 9 Phase 9.1/9.3 — Publishing domain invariants, extracted to
 * `@myev/shared` (Phase 9.3 Milestone A) so apps/api and apps/worker
 * share the exact same rules rather than risking drift between a
 * Nest-side and a worker-side copy. Pure functions, no Prisma/DB access,
 * no NestJS — callers resolve the actual ContentItem/VideoRenderJob/
 * PublicationTarget rows first (each process doing its own mechanical
 * fetch) and pass in primitives here.
 *
 * Behavior is unchanged from Phase 9.1's own apps/api-local version —
 * only the thrown error type changed, from NestJS ConflictException/
 * UnprocessableEntityException to the framework-free PublishingDomainError
 * (see that file's own doc comment). apps/api's own call sites translate
 * this into an HttpException at the boundary; apps/worker's translate it
 * into a retry/permanent-failure signal.
 */

// The only ContentItemStatus a publish request may ever act on — mirrors
// InternalLink's own ELIGIBLE_TARGET_STATUSES precedent exactly (the
// highest status any content item can actually reach today; RENDERING/
// FAILED/SCHEDULED/PUBLISHED remain reserved/unused by any Module 6/7
// code path, per the Architecture Checkpoint's own repository-reality
// finding).
const ELIGIBLE_CONTENT_STATUSES = ["APPROVED"];

/**
 * Blog eligibility is exactly `assertTargetEligible`'s own rule from
 * Module 8 (APPROVED, not deleted). Video eligibility additionally
 * requires a COMPLETED render job. This function deliberately does NOT
 * re-derive Module 7's own render-currentness hash check (scriptVersionHash
 * / sceneAssetFingerprint) — that lives deep inside Module 7's own
 * pipeline state and is out of scope for a shared domain primitive; a
 * later phase resolving a real artifact for upload is where that full
 * currentness check belongs (Phase 9.2/9.3 explicitly accepted this gap
 * as documented, non-blocking debt). This primitive checks only the two
 * facts genuinely visible from ContentItem/VideoRenderJob rows alone:
 * approved, and (for VIDEO) render-complete.
 *
 * Never mutates anything — Publishing must never alter Blog body, alter
 * Video render output, apply Module 8 recommendations, or downgrade
 * editorial approval; a read-only eligibility check satisfies that by
 * construction.
 */
export function assertContentPublishEligible(input: {
  contentType: PublishingContentType;
  status: string;
  deletedAt: Date | null;
  /** Required context only when contentType === "VIDEO"; ignored otherwise. */
  latestVideoRenderJobStatus?: PublishingVideoRenderJobStatus | null;
}): void {
  if (input.deletedAt !== null || !ELIGIBLE_CONTENT_STATUSES.includes(input.status)) {
    throw new PublishingDomainError(
      PUBLISHING_DOMAIN_ERROR_CODES.PUBLISHING_CONTENT_NOT_ELIGIBLE,
      `Content item is "${input.status}"${input.deletedAt !== null ? " (deleted)" : ""} — publishing requires APPROVED, non-deleted content.`,
    );
  }
  if (input.contentType === "VIDEO" && input.latestVideoRenderJobStatus !== "COMPLETED") {
    throw new PublishingDomainError(
      PUBLISHING_DOMAIN_ERROR_CODES.PUBLISHING_VIDEO_RENDER_NOT_READY,
      `Video content requires a COMPLETED render job before publishing (found "${input.latestVideoRenderJobStatus ?? "none"}").`,
    );
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
// destroying the exact history PublishAttempt is required to preserve.
// A retry re-enters the live/QUEUED state explicitly, keeping its full
// attempt history intact on the same target row.
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
    throw new PublishingDomainError(PUBLISHING_DOMAIN_ERROR_CODES.PUBLISHING_TARGET_INVALID_TRANSITION, `Cannot transition a publication target from "${from}" to "${to}".`);
  }
}

// The statuses the live-target DB uniqueness invariant (the Phase 9.1
// migration's hand-written partial unique index on publication_targets)
// treats as "currently occupying" a (workspace, content item, channel
// account) slot. PUBLISHED/FAILED/CANCELLED are history, never blocking
// a later independent publish attempt to the same target.
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
 * read time from its own PublicationTarget rows, never cached (Publication
 * itself persists no status column at all). Deliberately returns a
 * structured summary rather than a single collapsed enum, so a caller can
 * never accidentally render "PUBLISHED" for a Publication that actually
 * has one FAILED target sitting alongside three PUBLISHED ones.
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
