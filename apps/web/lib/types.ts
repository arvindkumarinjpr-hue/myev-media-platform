// Mirrors the backend's actual serialized response shapes exactly (see
// AuthController, WorkspacesController, ProjectsController,
// KnowledgePacksController) — never invented, always read off the real
// controller `serialize()`/return shapes.

export interface CurrentUser {
  publicId: string;
  email: string;
  fullName: string;
}

export interface WorkspaceSummary {
  publicId: string;
  name: string;
  slug: string;
  status: string;
}

export interface WorkspaceDetail extends WorkspaceSummary {
  settings: Record<string, unknown>;
  featureFlags: Record<string, unknown>;
  myRole: string;
}

export type KnowledgePackStatus = "DRAFT" | "VALIDATING" | "ACTIVE" | "ARCHIVED";

export const KNOWLEDGE_PACK_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"] as const;
export const KNOWLEDGE_SOURCE_TYPES = ["GOVERNMENT", "ASSOCIATION", "COMPANY", "PUBLICATION", "RSS"] as const;

export interface KnowledgePackSummary {
  publicId: string;
  name: string;
  status: KnowledgePackStatus;
  versionNumber: number;
}

export interface KnowledgeSource {
  sourceType: (typeof KNOWLEDGE_SOURCE_TYPES)[number];
  url: string;
}

export interface PromptTemplate {
  contentType: (typeof KNOWLEDGE_PACK_CONTENT_TYPES)[number];
  promptBody: string;
  versionNumber: number;
}

export interface SeoRule {
  primaryKeywords: string[];
  secondaryKeywords: string[];
  internalLinkingPolicy: Record<string, unknown>;
  schemaPreferences: Record<string, unknown>;
}

export interface BrandGuideline {
  toneOfVoice: string | null;
  terminology: Record<string, unknown>;
  ctaRules: string | null;
  logoAssetId: string | null;
}

export interface KeywordSet {
  name: string;
  keywords: string[];
}

export interface Competitor {
  domain: string;
  notes: string | null;
}

export interface KnowledgePackDetail extends KnowledgePackSummary {
  lockVersion: number;
  industryProfile: Record<string, unknown>;
  publishingStrategy: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  sources: KnowledgeSource[];
  promptTemplates: PromptTemplate[];
  seoRules: SeoRule[];
  brandGuidelines: BrandGuideline[];
  keywordSets: KeywordSet[];
  competitors: Competitor[];
}

export interface KnowledgePackVersion {
  publicId: string;
  name: string;
  status: KnowledgePackStatus;
  versionNumber: number;
  currentVersionOfPublicId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectSummary {
  publicId: string;
  name: string;
  slug: string;
  status: string;
  knowledgePackPublicId: string | null;
}
