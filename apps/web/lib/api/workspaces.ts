import { apiClient } from "../api-client";
import type { WorkspaceDetail, WorkspaceSummary } from "../types";

export const workspacesApi = {
  listMine: () => apiClient.get<WorkspaceSummary[]>("workspaces"),
  get: (workspaceId: string) => apiClient.get<WorkspaceDetail>(`workspaces/${workspaceId}`),
  getMyPermissions: (workspaceId: string) => apiClient.get<{ permissions: string[] }>(`workspaces/${workspaceId}/permissions/me`),
};
