import { apiClient } from "../api-client";
import type {
  BrandGuideline,
  Competitor,
  KeywordSet,
  KnowledgePackDetail,
  KnowledgePackSummary,
  KnowledgePackVersion,
  KnowledgeSource,
  PromptTemplate,
  SeoRule,
} from "../types";

export interface CreateKnowledgePackInput {
  name: string;
  projectId?: string;
  industryProfile?: Record<string, unknown>;
  publishingStrategy?: Record<string, unknown>;
}

// Every child collection is a wholesale replace when present (mirrors
// UpdateKnowledgePackDto / replaceChildCollections exactly) — omit a key
// to leave that collection untouched, send `[]` to clear it.
export interface UpdateKnowledgePackInput {
  expectedLockVersion: number;
  name?: string;
  industryProfile?: Record<string, unknown>;
  publishingStrategy?: Record<string, unknown>;
  sources?: KnowledgeSource[];
  promptTemplates?: Pick<PromptTemplate, "contentType" | "promptBody">[];
  seoRules?: SeoRule[];
  brandGuidelines?: (Pick<BrandGuideline, "toneOfVoice" | "ctaRules" | "logoAssetId"> & { terminology?: Record<string, unknown> })[];
  keywordSets?: KeywordSet[];
  competitors?: Competitor[];
}

export const knowledgePacksApi = {
  list: (workspaceId: string, projectId?: string) =>
    apiClient.get<KnowledgePackSummary[]>(`workspaces/${workspaceId}/knowledge-packs${projectId ? `?projectId=${projectId}` : ""}`),
  get: (workspaceId: string, knowledgePackId: string) =>
    apiClient.get<KnowledgePackDetail>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}`),
  create: (workspaceId: string, input: CreateKnowledgePackInput) =>
    apiClient.post<KnowledgePackDetail>(`workspaces/${workspaceId}/knowledge-packs`, input),
  update: (workspaceId: string, knowledgePackId: string, input: UpdateKnowledgePackInput) =>
    apiClient.patch<KnowledgePackDetail>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}`, input),
  remove: (workspaceId: string, knowledgePackId: string) =>
    apiClient.delete<{ success: boolean }>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}`),
  validate: (workspaceId: string, knowledgePackId: string) =>
    apiClient.post<KnowledgePackDetail>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}/validate`),
  archive: (workspaceId: string, knowledgePackId: string) =>
    apiClient.post<KnowledgePackDetail>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}/archive`),
  createVersion: (workspaceId: string, knowledgePackId: string) =>
    apiClient.post<KnowledgePackDetail>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}/versions`),
  listVersions: (workspaceId: string, knowledgePackId: string) =>
    apiClient.get<KnowledgePackVersion[]>(`workspaces/${workspaceId}/knowledge-packs/${knowledgePackId}/versions`),
};
