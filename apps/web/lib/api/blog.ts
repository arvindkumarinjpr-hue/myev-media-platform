import { apiClient } from "../api-client";
import type { BlogListItem, BlogPipeline, BlogScoreFeedback } from "../types";

export interface CreateBlogInput {
  topic: string;
  knowledgePackVersionId: string;
  projectId?: string;
  seriesId?: string;
}

const base = (workspaceId: string) => `workspaces/${workspaceId}/blog`;

/**
 * Module 6 Phase 6.4 — the one typed Blog client. Every page/component
 * goes through here (no duplicated fetch logic). Read calls (`get`,
 * `score`) hit the Phase 6.3 read-only projection; every other call is a
 * pipeline mutation whose HTTP response is the refreshed read model.
 * `GET :id/score` is gated by BLOG_VIEW on the backend; `runScore` (POST)
 * still needs SEO_SCORE.
 */
export const blogApi = {
  list: (workspaceId: string) => apiClient.get<BlogListItem[]>(base(workspaceId)),
  get: (workspaceId: string, itemId: string) => apiClient.get<BlogPipeline>(`${base(workspaceId)}/${itemId}`),
  create: (workspaceId: string, input: CreateBlogInput) => apiClient.post<BlogPipeline>(base(workspaceId), input),

  score: (workspaceId: string, itemId: string) => apiClient.get<BlogScoreFeedback | null>(`${base(workspaceId)}/${itemId}/score`),

  generateBrief: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/brief`),
  approveBrief: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/brief/approve`),
  generateOutline: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/outline`),
  approveOutline: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/outline/approve`),
  generateDraft: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/draft`),
  generateSeo: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/seo`),
  runInternalLinking: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/internal-linking`),
  runQa: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/qa`),
  runScore: (workspaceId: string, itemId: string) => apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/score`),

  submitForReview: (workspaceId: string, itemId: string, comment?: string) =>
    apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/submit-for-review`, comment ? { comment } : undefined),
  approve: (workspaceId: string, itemId: string, comment?: string) =>
    apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/approve`, comment ? { comment } : undefined),
  reject: (workspaceId: string, itemId: string, comment: string) =>
    apiClient.post<BlogPipeline>(`${base(workspaceId)}/${itemId}/reject`, { comment }),
};
