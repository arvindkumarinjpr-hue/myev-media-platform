import { apiClient } from "../api-client";
import type { ContentItemSummary } from "../types";

/**
 * Module 10 Phase 10.6 — the generic content-item read used by the Social
 * source picker. Deliberately the SAME endpoint Blog/Video's own list
 * pages sit beside (`GET /workspaces/:id/content-items`), not Module 9's
 * `publications/content-candidates` (that list is "what Publishing can
 * push to a channel" — already includes SOCIAL_POST itself since Phase
 * 10.4, and is gated by PUBLISH_CREATE, a permission a Social-only role
 * like Content Writer never holds). ContentItemsService.list() narrows
 * per-contentType by the caller's own BLOG_VIEW/VIDEO_VIEW automatically
 * and returns an empty array (never a 403) for a type the caller can't
 * see — so calling this once per source type and merging is workspace-
 * and permission-safe with no additional backend work.
 */
const base = (workspaceId: string) => `workspaces/${workspaceId}/content-items`;

export const contentItemsApi = {
  list: (workspaceId: string, filters: { contentType?: string; status?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.contentType) params.set("contentType", filters.contentType);
    if (filters.status) params.set("status", filters.status);
    const qs = params.toString();
    return apiClient.get<ContentItemSummary[]>(`${base(workspaceId)}${qs ? `?${qs}` : ""}`);
  },
  get: (workspaceId: string, itemId: string) => apiClient.get<ContentItemSummary>(`${base(workspaceId)}/${itemId}`),
};
