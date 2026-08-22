import { apiClient } from "../api-client";
import type { ProjectSummary } from "../types";

export const projectsApi = {
  list: (workspaceId: string) => apiClient.get<ProjectSummary[]>(`workspaces/${workspaceId}/projects`),
  get: (workspaceId: string, projectId: string) => apiClient.get<ProjectSummary>(`workspaces/${workspaceId}/projects/${projectId}`),
  // knowledgePackId: a Knowledge Pack public_id to assign, or null to unassign. Omitting the field entirely (not exposed here) leaves it unchanged — this module always sends it explicitly since that's the only thing this UI control does.
  assignKnowledgePack: (workspaceId: string, projectId: string, knowledgePackId: string | null) =>
    apiClient.patch<ProjectSummary>(`workspaces/${workspaceId}/projects/${projectId}`, { knowledgePackId }),
};
