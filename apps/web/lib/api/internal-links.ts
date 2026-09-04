import { apiClient } from "../api-client";
import type { ClusterLinkHealth, InternalLinkMutationResult, InternalLinkRecommendation, OrphanBlog, WorkspaceLinkHealthSummary } from "../types";

const blogBase = (workspaceId: string, itemId: string) => `workspaces/${workspaceId}/blog/${itemId}/internal-links`;
const linksBase = (workspaceId: string) => `workspaces/${workspaceId}/internal-links`;

/**
 * Module 8 Phase 8.6 — the one typed Internal Linking client. Mirrors
 * blogApi's conventions exactly: every function takes workspaceId (and
 * itemId/id where relevant) explicitly, thinly wraps apiClient, no
 * fetch() calls scattered across components.
 *
 * Two base paths, matching the backend's own split (see
 * BlogInternalLinksController vs InternalLinksController): generate/list
 * are keyed by the source Blog item; anchor-edit/accept/reject are keyed
 * by the recommendation's own id.
 */
export const internalLinksApi = {
  listForItem: (workspaceId: string, itemId: string) => apiClient.get<InternalLinkRecommendation[]>(blogBase(workspaceId, itemId)),
  generate: (workspaceId: string, itemId: string) => apiClient.post<InternalLinkRecommendation[]>(`${blogBase(workspaceId, itemId)}/generate`),

  updateAnchor: (workspaceId: string, id: string, anchorText: string) =>
    apiClient.patch<InternalLinkMutationResult>(`${linksBase(workspaceId)}/${id}`, { anchorText }),
  accept: (workspaceId: string, id: string) => apiClient.post<InternalLinkMutationResult>(`${linksBase(workspaceId)}/${id}/accept`),
  reject: (workspaceId: string, id: string, rejectionReason: string) =>
    apiClient.post<InternalLinkMutationResult>(`${linksBase(workspaceId)}/${id}/reject`, { rejectionReason }),

  orphans: (workspaceId: string) => apiClient.get<OrphanBlog[]>(`${linksBase(workspaceId)}/orphans`),
  clusterHealth: (workspaceId: string) => apiClient.get<ClusterLinkHealth[]>(`${linksBase(workspaceId)}/cluster-health`),
  summary: (workspaceId: string) => apiClient.get<WorkspaceLinkHealthSummary>(`${linksBase(workspaceId)}/summary`),
};
