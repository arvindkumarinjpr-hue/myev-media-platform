/**
 * Module 10 Phase 10.1 — the one error type every Social Media domain
 * function throws, mirroring PublishingDomainError's exact shape
 * (packages/shared/src/publishing/publishing-domain-error.ts): a plain
 * Error subclass, never a NestJS HttpException, so this stays testable
 * with zero DI/framework setup. The (not-yet-built) HTTP controller
 * layer catches this and translates code/message into a typed
 * HttpException, the same job publishing-error-translation.ts already
 * does for PublishingDomainError.
 */
export class SocialDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SocialDomainError";
  }
}

export const SOCIAL_DOMAIN_ERRORS = {
  SOCIAL_SOURCE_NOT_APPROVED: "SOCIAL_SOURCE_NOT_APPROVED",
  SOCIAL_SOURCE_CONTENT_TYPE_UNSUPPORTED: "SOCIAL_SOURCE_CONTENT_TYPE_UNSUPPORTED",
  SOCIAL_SOURCE_DELETED: "SOCIAL_SOURCE_DELETED",
  SOCIAL_SOURCE_WORKSPACE_MISMATCH: "SOCIAL_SOURCE_WORKSPACE_MISMATCH",
} as const;

/**
 * Module 10 Phase 10.1 Part G — the exact source-eligibility rule
 * (Architecture Checkpoint §5/§13, Phase 10.1 Part D): "Module 10
 * creates social content FROM approved editorial content" — nothing
 * else. Enforced here, at the domain layer, so no future caller
 * (HTTP controller, a later background job, a script) can accidentally
 * bypass it by skipping a UI-only check.
 *
 * Pure and framework-agnostic on purpose — takes plain facts, never a
 * Prisma row or a NestJS request — so it is fully unit-testable without
 * a database, and reusable unchanged once a real create-from-source
 * service exists (Phase 10.2+).
 *
 * Checked in this order deliberately: workspace isolation first (never
 * even acknowledge a cross-workspace item's other properties), then
 * deletion (a deleted item is never a valid source regardless of its
 * stale status value), then content type (SOCIAL_POST-as-source and the
 * 3 still-reserved types are rejected here, before ever asking whether
 * they're "Approved" — a SOCIAL_POST simply can never be an eligible
 * source in v1, independent of its own status), then status.
 */
const ELIGIBLE_SOCIAL_SOURCE_CONTENT_TYPES = ["BLOG", "VIDEO"] as const;

export interface SocialSourceCandidate {
  contentType: string;
  status: string;
  deletedAt: Date | null;
  workspaceId: string;
}

export function assertSocialSourceEligible(source: SocialSourceCandidate, targetWorkspaceId: string): void {
  if (source.workspaceId !== targetWorkspaceId) {
    throw new SocialDomainError(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_WORKSPACE_MISMATCH, "The source content item does not belong to this workspace.");
  }
  if (source.deletedAt !== null) {
    throw new SocialDomainError(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_DELETED, "The source content item has been deleted.");
  }
  if (!(ELIGIBLE_SOCIAL_SOURCE_CONTENT_TYPES as readonly string[]).includes(source.contentType)) {
    throw new SocialDomainError(
      SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_CONTENT_TYPE_UNSUPPORTED,
      "Only an Approved Blog or Video can be the source for a social post.",
    );
  }
  if (source.status !== "APPROVED") {
    throw new SocialDomainError(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_NOT_APPROVED, "The source content item must be Approved.");
  }
}
