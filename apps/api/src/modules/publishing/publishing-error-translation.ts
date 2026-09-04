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
    if (error.code === "PUBLISHING_TARGET_INVALID_TRANSITION") {
      throw new ConflictException({ code: error.code, message: error.message });
    }
    throw new UnprocessableEntityException({ code: error.code, message: error.message });
  }
  throw error;
}
