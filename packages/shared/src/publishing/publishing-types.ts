/**
 * Module 9 Phase 9.3 — local mirrors of Prisma-generated Publishing enum
 * values, kept as plain string-literal unions so `@myev/shared` need not
 * depend on the Prisma-generated client (same precedent as
 * `agent-execution-status.ts`'s own `AgentExecutionStatus` union and
 * `ScoringInput.contentType`'s documented rationale). These are frozen
 * Phase 9.1/9.2 enum shapes — kept in sync with `schema.prisma` by
 * convention, not by a generated/shared source, exactly like every other
 * enum mirror in this package.
 */

/** Mirrors Prisma `ContentType`. Only BLOG/VIDEO have a publish path today; the others are carried for type accuracy against the real column. */
export type PublishingContentType = "BLOG" | "VIDEO" | "SHORT" | "REEL" | "NEWSLETTER" | "SOCIAL_POST";

/** Mirrors Prisma `PublishingChannelType`. */
export type PublishingChannelType = "WORDPRESS" | "YOUTUBE" | "FACEBOOK" | "INSTAGRAM";

/** Mirrors Prisma `PublishingConnectionStatus`. */
export type PublishingConnectionStatus = "CONNECTED" | "EXPIRED" | "REVOKED" | "ERROR";

/** Mirrors Prisma `PublicationTargetStatus`. */
export type PublicationTargetStatus = "PENDING" | "SCHEDULED" | "QUEUED" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "CANCELLED";

/** Mirrors Prisma `VideoRenderJobStatus` — only the subset publishing readiness needs to compare against. */
export type PublishingVideoRenderJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMED_OUT";
