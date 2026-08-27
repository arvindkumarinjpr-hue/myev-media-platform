import { apiClient } from "../api-client";
import type { TopicCluster } from "../types";

export interface CreateTopicClusterInput {
  researchId: string;
  keywordClusterTopic: string;
  name?: string;
  contentSeriesId?: string;
}

export const topicClustersApi = {
  list: (workspaceId: string) => apiClient.get<TopicCluster[]>(`workspaces/${workspaceId}/topic-clusters`),
  get: (workspaceId: string, topicClusterId: string) => apiClient.get<TopicCluster>(`workspaces/${workspaceId}/topic-clusters/${topicClusterId}`),
  create: (workspaceId: string, input: CreateTopicClusterInput) => apiClient.post<TopicCluster>(`workspaces/${workspaceId}/topic-clusters`, input),
};
