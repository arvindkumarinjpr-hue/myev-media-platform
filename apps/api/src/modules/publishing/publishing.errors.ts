/**
 * Module 9 Phase 9.1 — Publishing / Content Distribution Engine, domain +
 * persistence foundation error codes.
 *
 * Every code here maps to a real domain invariant this phase actually
 * enforces (content publish eligibility, target lifecycle transitions,
 * credential encryption configuration). No code is added for behavior
 * this phase doesn't implement (no provider connectors, no scheduling,
 * no OAuth — those are later phases). Shape ({ code, message }) matches
 * the codebase-wide convention (see INTERNAL_LINK_ERRORS/BLOG_ERRORS).
 */
export const PUBLISHING_ERRORS = {
  // Lookup / workspace isolation
  PUBLISHING_CONTENT_ITEM_NOT_FOUND: "PUBLISHING_CONTENT_ITEM_NOT_FOUND",
  PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND: "PUBLISHING_CHANNEL_ACCOUNT_NOT_FOUND",
  PUBLISHING_TARGET_NOT_FOUND: "PUBLISHING_TARGET_NOT_FOUND",

  // Content eligibility (Architecture Checkpoint §5/Part L)
  PUBLISHING_CONTENT_NOT_ELIGIBLE: "PUBLISHING_CONTENT_NOT_ELIGIBLE",
  PUBLISHING_VIDEO_RENDER_NOT_READY: "PUBLISHING_VIDEO_RENDER_NOT_READY",

  // PublicationTarget lifecycle (Part J)
  PUBLISHING_TARGET_INVALID_TRANSITION: "PUBLISHING_TARGET_INVALID_TRANSITION",

  // Duplicate / race safety (Part M) — the DB's partial unique index on
  // (workspace_id, content_item_id, channel_account_id) WHERE status is
  // live is the final concurrency authority; this is what a caught
  // unique-constraint violation on it is mapped to, never leaked as a
  // raw Prisma/Postgres error. Same precedent as Module 8's own
  // INTERNAL_LINK_ACTIVE_RECOMMENDATION_EXISTS.
  PUBLISHING_LIVE_TARGET_EXISTS: "PUBLISHING_LIVE_TARGET_EXISTS",

  // Credential encryption (Part Q)
  PUBLISHING_CREDENTIAL_ENCRYPTION_KEY_INVALID: "PUBLISHING_CREDENTIAL_ENCRYPTION_KEY_INVALID",
  PUBLISHING_CREDENTIAL_DECRYPTION_FAILED: "PUBLISHING_CREDENTIAL_DECRYPTION_FAILED",

  // Phase 9.2 — provider abstraction / resolution. Provider absence must
  // be typed and non-catastrophic (never a crash at startup or an
  // unhandled throw at resolution time) — see publishing-provider-
  // resolver.service.ts.
  PUBLISHING_PROVIDER_NOT_CONFIGURED: "PUBLISHING_PROVIDER_NOT_CONFIGURED",
  PUBLISHING_CHANNEL_ACCOUNT_NOT_CONNECTED: "PUBLISHING_CHANNEL_ACCOUNT_NOT_CONNECTED",
  PUBLISHING_CREDENTIAL_UNAVAILABLE: "PUBLISHING_CREDENTIAL_UNAVAILABLE",
  PUBLISHING_CREDENTIAL_EXPIRED: "PUBLISHING_CREDENTIAL_EXPIRED",
} as const;

export type PublishingErrorCode = (typeof PUBLISHING_ERRORS)[keyof typeof PUBLISHING_ERRORS];
