import type { PublishingChannelType } from "../../lib/types";

/** Text labels only (Part AC) — no unofficial logo assets are bundled into this repository. */
export const CHANNEL_LABEL: Record<PublishingChannelType, string> = {
  WORDPRESS: "WordPress",
  YOUTUBE: "YouTube",
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
};

/** Which content types each channel can actually publish (Part D/H) — matches each provider's own getCapabilities() truthfully; never invented. */
export const CHANNEL_SUPPORTED_CONTENT_TYPES: Record<PublishingChannelType, ("BLOG" | "VIDEO")[]> = {
  WORDPRESS: ["BLOG"],
  YOUTUBE: ["VIDEO"],
  FACEBOOK: ["VIDEO"],
  INSTAGRAM: ["VIDEO"],
};

export const READINESS_REASON_LABEL: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: "This channel is not configured on the platform.",
  CONTENT_DELETED: "This content item has been deleted.",
  CONTENT_NOT_APPROVED: "This content item is not yet Approved.",
  CHANNEL_NOT_SUPPORTED: "This channel does not support this content type.",
  CHANNEL_ACCOUNT_NOT_CONNECTED: "This channel account is not connected.",
  CREDENTIAL_EXPIRED: "The stored credential for this account has expired.",
  CREDENTIAL_REVOKED: "The stored credential for this account was revoked.",
  CREDENTIAL_INVALID: "The stored credential for this account is invalid.",
  PROVIDER_UNAVAILABLE: "The channel's own service is temporarily unavailable.",
  VIDEO_RENDER_NOT_READY: "The video has not finished rendering yet.",
  BLOG_ARTICLE_MISSING: "This blog is missing its SEO article details.",
  BLOG_PUBLISHING_CONTENT_MISSING: "This blog's publishing content could not be resolved.",
  REQUIRED_METADATA_MISSING: "Required metadata (title/description) is missing.",
};

export function readinessReasonLabel(code: string): string {
  return READINESS_REASON_LABEL[code] ?? code;
}
