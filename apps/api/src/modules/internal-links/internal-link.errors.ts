/**
 * Module 8 Phase 8.1 — Internal Linking Engine, domain + persistence
 * foundation error codes.
 *
 * Every code here maps to a real domain invariant enforced in this phase
 * (self-link rejection, source/target eligibility, transition validity,
 * duplicate/race safety). No code is added for behavior this phase
 * doesn't actually implement (discovery, scoring, anchor generation are
 * Phase 8.2/8.3). The shape ({ code, message }) matches the codebase-wide
 * convention every other module's Nest exceptions use (see BLOG_ERRORS).
 */
export const INTERNAL_LINK_ERRORS = {
  // Lookup / workspace isolation
  INTERNAL_LINK_SOURCE_NOT_FOUND: "INTERNAL_LINK_SOURCE_NOT_FOUND",
  INTERNAL_LINK_TARGET_NOT_FOUND: "INTERNAL_LINK_TARGET_NOT_FOUND",
  INTERNAL_LINK_NOT_FOUND: "INTERNAL_LINK_NOT_FOUND",

  // Domain invariants (D11, D3, D5)
  INTERNAL_LINK_SELF_LINK_NOT_ALLOWED: "INTERNAL_LINK_SELF_LINK_NOT_ALLOWED",
  INTERNAL_LINK_SOURCE_NOT_ELIGIBLE: "INTERNAL_LINK_SOURCE_NOT_ELIGIBLE",
  INTERNAL_LINK_TARGET_NOT_ELIGIBLE: "INTERNAL_LINK_TARGET_NOT_ELIGIBLE",
  INTERNAL_LINK_INVALID_RELEVANCE_SCORE: "INTERNAL_LINK_INVALID_RELEVANCE_SCORE",

  // Lifecycle (D9)
  INTERNAL_LINK_INVALID_TRANSITION: "INTERNAL_LINK_INVALID_TRANSITION",

  // Discovery (Phase 8.2) — v1 is Blog -> Blog only (corrected D2).
  INTERNAL_LINK_DISCOVERY_SOURCE_NOT_BLOG: "INTERNAL_LINK_DISCOVERY_SOURCE_NOT_BLOG",

  // Duplicate / race safety (D8/D11, correction §5) — the DB's partial
  // unique index is the final concurrency authority; this is what a
  // caught unique-constraint violation on the active-pair index is
  // mapped to, never leaked as a raw Prisma/Postgres error.
  INTERNAL_LINK_ACTIVE_RECOMMENDATION_EXISTS: "INTERNAL_LINK_ACTIVE_RECOMMENDATION_EXISTS",
} as const;

export type InternalLinkErrorCode = (typeof INTERNAL_LINK_ERRORS)[keyof typeof INTERNAL_LINK_ERRORS];
