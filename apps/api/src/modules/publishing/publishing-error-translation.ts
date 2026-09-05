import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { PublishingDomainError } from "@myev/shared";

/**
 * Translates a shared, framework-free PublishingDomainError (thrown by
 * `@myev/shared`'s assertContentPublishEligible/assertPublicationTargetTransition)
 * into this process's own HTTP exception idiom — Phase 9.3 Milestone A's
 * apps/api boundary, mirroring agent-executor.service.ts's own
 * AgentExecutionResolutionError catch-and-translate pattern. Never
 * rethrows a raw PublishingDomainError past this point. Shared by every
 * apps/api Publishing service that calls a shared domain-rule function
 * (never duplicated per call site).
 */
export function translatePublishingDomainError(error: unknown): never {
  if (error instanceof PublishingDomainError) {
    // Module 9 Phase 9.7 — both reconciliation guards are, like
    // PUBLISHING_TARGET_INVALID_TRANSITION, "this action doesn't apply
    // to the target's current state" rather than a request-validation
    // problem — Conflict (409), not Unprocessable Entity (422).
    if (error.code === "PUBLISHING_TARGET_INVALID_TRANSITION" || error.code === "PUBLISHING_RECONCILIATION_REQUIRED" || error.code === "PUBLISHING_RECONCILIATION_NOT_APPLICABLE") {
      throw new ConflictException({ code: error.code, message: error.message });
    }
    throw new UnprocessableEntityException({ code: error.code, message: error.message });
  }
  throw error;
}
