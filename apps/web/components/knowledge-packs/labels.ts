import type { KnowledgePackStatus } from "../../lib/types";

/** Friendly display labels for the stored enum values — the enum values themselves are never changed. */

export const CONTENT_TYPE_LABELS: Record<string, string> = {
  BLOG: "Blog",
  VIDEO: "Video",
  SHORT: "Short",
  REEL: "Reel",
  NEWSLETTER: "Newsletter",
  SOCIAL_POST: "Social Post",
};

export const SOURCE_TYPE_LABELS: Record<string, string> = {
  GOVERNMENT: "Government",
  ASSOCIATION: "Industry association",
  COMPANY: "Company",
  PUBLICATION: "Research publication",
  RSS: "RSS feed",
};

export const STATUS_HELP: Record<KnowledgePackStatus, string> = {
  DRAFT: "This version is editable. Validate it to make it the active context.",
  VALIDATING: "This version is being checked.",
  ACTIVE: "This is the live context your content agents use.",
  ARCHIVED: "This version has been retired and can't be reactivated.",
};

export function contentTypeLabel(value: string): string {
  return CONTENT_TYPE_LABELS[value] ?? value;
}

export function sourceTypeLabel(value: string): string {
  return SOURCE_TYPE_LABELS[value] ?? value;
}
