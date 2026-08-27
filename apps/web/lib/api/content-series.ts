import { apiClient } from "../api-client";
import type { ContentSeries } from "../types";

export interface CreateContentSeriesInput {
  name: string;
  projectId?: string;
}

export const contentSeriesApi = {
  list: (workspaceId: string) => apiClient.get<ContentSeries[]>(`workspaces/${workspaceId}/content-series`),
  create: (workspaceId: string, input: CreateContentSeriesInput) => apiClient.post<ContentSeries>(`workspaces/${workspaceId}/content-series`, input),
};
