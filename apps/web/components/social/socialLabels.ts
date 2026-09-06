import type { BadgeTone } from "../ui/Badge";
import type { ContentItemStatus, SocialPlatform } from "../../lib/types";

/**
 * The same generic ContentItemStatus map Blog/Video each keep their own
 * copy of (blogLabels.ts / videoLabels.ts) — Social has no multi-stage AI
 * pipeline of its own, so this file only needs the item-level status plus
 * a couple of Social-specific label maps, not a full "stages" module.
 */
export const CONTENT_ITEM_STATUS: Record<ContentItemStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  IN_PROGRESS: { label: "In progress", tone: "info", dot: true },
  REVIEW: { label: "In review", tone: "warning", dot: true },
  APPROVED: { label: "Approved", tone: "success" },
  SCHEDULED: { label: "Scheduled", tone: "info" },
  PUBLISHED: { label: "Published", tone: "success" },
  ARCHIVED: { label: "Archived", tone: "neutral" },
  DELETED: { label: "Deleted", tone: "neutral" },
  RENDERING: { label: "Rendering", tone: "info", dot: true },
  FAILED: { label: "Failed", tone: "danger" },
};

export const PLATFORM_LABEL: Record<SocialPlatform, string> = {
  FACEBOOK: "Facebook",
  INSTAGRAM: "Instagram",
};

export const SOURCE_TYPE_LABEL: Record<string, string> = {
  BLOG: "Blog",
  VIDEO: "Video",
};

/**
 * Module 10 Phase 10.5's own `REEL_TARGET_PLATFORM_BY_SOCIAL_PLATFORM`
 * (SocialGenerationService), mirrored here for DISPLAY only — this tells
 * the media picker which of a source Video's render(s) the backend would
 * treat as the compatible one, so the UI can label it clearly ("existing
 * Facebook Reel render") instead of guessing. It changes nothing about
 * what's actually attachable: PATCH .../social-posts/:id still accepts
 * any ACTIVE same-workspace MediaAsset, and readiness (SOCIAL_MEDIA_
 * INCOMPATIBLE) remains the sole authority on whether a chosen asset is
 * actually usable.
 */
export const REEL_TARGET_PLATFORM_BY_SOCIAL_PLATFORM: Record<SocialPlatform, string> = {
  FACEBOOK: "FACEBOOK_REEL",
  INSTAGRAM: "INSTAGRAM_REEL",
};

export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
