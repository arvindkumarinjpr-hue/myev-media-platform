import { apiClient } from "../api-client";
import type { Research } from "../types";

export interface CreateResearchInput {
  topic: string;
  knowledgePackVersionId: string;
  objective?: string;
  geography?: string;
  language?: string;
  seedKeywords?: string[];
}

export const researchApi = {
  list: (workspaceId: string) => apiClient.get<Research[]>(`workspaces/${workspaceId}/research`),
  get: (workspaceId: string, researchId: string) => apiClient.get<Research>(`workspaces/${workspaceId}/research/${researchId}`),
  create: (workspaceId: string, input: CreateResearchInput) => apiClient.post<Research>(`workspaces/${workspaceId}/research`, input),
};
