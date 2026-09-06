import { apiClient } from "../api-client";
import type { SocialPlatform, SocialPostDetail, SocialPostListItem, SocialPostVersion } from "../types";

const base = (workspaceId: string) => `workspaces/${workspaceId}/social-posts`;

export interface CreateSocialPostInput {
  sourceContentItemId: string;
  platform: SocialPlatform;
  knowledgePackVersionId: string;
}

export interface EditSocialPostInput {
  caption?: string;
  hashtags?: string[];
  ctaObjective?: string;
  /** undefined = leave media unchanged; null = detach; a publicId = attach/replace. */
  mediaAssetPublicId?: string | null;
}

/**
 * Module 10 Phase 10.2/10.3/10.5 — the Social Media API client. Every
 * mutation here (`edit`, `regenerate`, `submitForReview`, `approve`,
 * `reject`) returns only a minimal `{publicId, status, ...}` shape from
 * the backend (SocialService/SocialGenerationService reuse
 * ContentItemsService.createVersion()'s own return value verbatim) — never
 * the full enriched read model VideoPipeline's own mutations return. Every
 * caller must re-fetch `get()` after a successful mutation to refresh
 * caption/hashtags/media/version state; see useSocialPost's `refresh()`.
 */
export const socialApi = {
  list: (workspaceId: string, filters: { platform?: string; status?: string; sourceContentItemId?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.platform) params.set("platform", filters.platform);
    if (filters.status) params.set("status", filters.status);
    if (filters.sourceContentItemId) params.set("sourceContentItemId", filters.sourceContentItemId);
    const qs = params.toString();
    return apiClient.get<SocialPostListItem[]>(`${base(workspaceId)}${qs ? `?${qs}` : ""}`);
  },
  get: (workspaceId: string, itemId: string) => apiClient.get<SocialPostDetail>(`${base(workspaceId)}/${itemId}`),
  listVersions: (workspaceId: string, itemId: string) => apiClient.get<SocialPostVersion[]>(`${base(workspaceId)}/${itemId}/versions`),
  create: (workspaceId: string, input: CreateSocialPostInput) => apiClient.post<{ publicId: string; title: string; status: string; contentType: string; platform: SocialPlatform; sourceContentItemPublicId: string }>(base(workspaceId), input),
  edit: (workspaceId: string, itemId: string, input: EditSocialPostInput) =>
    apiClient.patch<{ publicId: string; status: string; currentVersionId: string | null }>(`${base(workspaceId)}/${itemId}`, input),
  regenerate: (workspaceId: string, itemId: string, knowledgePackVersionId: string) =>
    apiClient.post<{ publicId: string; status: string; currentVersionId: string | null }>(`${base(workspaceId)}/${itemId}/regenerate`, { knowledgePackVersionId }),
  submitForReview: (workspaceId: string, itemId: string, comment?: string) =>
    apiClient.post<{ publicId: string; status: string }>(`${base(workspaceId)}/${itemId}/submit-for-review`, comment ? { comment } : undefined),
  approve: (workspaceId: string, itemId: string, comment?: string) =>
    apiClient.post<{ publicId: string; status: string }>(`${base(workspaceId)}/${itemId}/approve`, comment ? { comment } : undefined),
  reject: (workspaceId: string, itemId: string, comment: string) =>
    apiClient.post<{ publicId: string; status: string }>(`${base(workspaceId)}/${itemId}/reject`, { comment }),
};
