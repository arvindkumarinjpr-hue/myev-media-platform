/**
 * Module 9 Phase 9.2/9.3 — stable, machine-readable readiness reason
 * codes. Human-readable messages, if ever needed, are derived separately
 * from these codes — never the other way around.
 */
export const PUBLISHING_READINESS_REASONS = {
  CONTENT_NOT_APPROVED: "CONTENT_NOT_APPROVED",
  CONTENT_DELETED: "CONTENT_DELETED",
  CHANNEL_NOT_SUPPORTED: "CHANNEL_NOT_SUPPORTED",
  CHANNEL_ACCOUNT_NOT_CONNECTED: "CHANNEL_ACCOUNT_NOT_CONNECTED",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  CREDENTIAL_UNAVAILABLE: "CREDENTIAL_UNAVAILABLE",
  CREDENTIAL_EXPIRED: "CREDENTIAL_EXPIRED",
  CREDENTIAL_INVALID: "CREDENTIAL_INVALID",
  REQUIRED_METADATA_MISSING: "REQUIRED_METADATA_MISSING",
  BLOG_ARTICLE_MISSING: "BLOG_ARTICLE_MISSING",
  RENDER_NOT_READY: "RENDER_NOT_READY",
  MEDIA_ASSET_MISSING: "MEDIA_ASSET_MISSING",
  MEDIA_ASSET_INELIGIBLE: "MEDIA_ASSET_INELIGIBLE",
} as const;

export type PublishingReadinessReasonCode = (typeof PUBLISHING_READINESS_REASONS)[keyof typeof PUBLISHING_READINESS_REASONS];

export interface PublishingReadinessMetadata {
  title?: string;
  description?: string;
  tags?: string[];
  caption?: string;
}

/**
 * The full result of one readiness evaluation. Never persisted — read-
 * only, computed fresh on every call, and creates zero rows/side
 * effects.
 */
export interface PublishingReadinessResult {
  ready: boolean;
  blockingReasons: PublishingReadinessReasonCode[];
  warnings: PublishingReadinessReasonCode[];
  resolvedArtifact: { mediaAssetPublicId: string } | null;
  metadata: PublishingReadinessMetadata;
}
