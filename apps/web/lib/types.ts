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

// Module 4 Phase 4.1 — mirrors ResearchController's own serialize() shape
// exactly (a research-shaped wrapper over the generic AiJob read model).
export type ResearchStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "TIMED_OUT";

export interface ResearchFinding {
  summary: string;
  evidence?: string;
  sourceUrls: string[];
}

export interface ResearchSource {
  url: string;
  sourceType: string;
  title?: string;
}

export interface TrendSignal {
  topic: string;
  direction: "rising" | "steady" | "declining";
  confidence: number;
  evidence: string;
}

export interface KeywordOpportunity {
  keyword: string;
  intent: "informational" | "transactional" | "navigational" | "unknown";
  opportunityScore: number;
  rationale: string;
}

// Module 4 Phase 4.2 (FR-RES-004) — always present once status ===
// "COMPLETED": RESEARCH_AGENT_V1's own postProcessOutput hook fills this
// in unconditionally, whether or not anything was actually deduplicated.
export interface ResearchDeduplicationSummary {
  duplicateFindingsRemoved: number;
  duplicateSourcesRemoved: number;
  requiresManualReview: boolean;
  reviewReason?: string;
}

export interface ResearchResult {
  executiveSummary: string;
  findings: ResearchFinding[];
  sources: ResearchSource[];
  trendSignals: TrendSignal[];
  keywordOpportunities: KeywordOpportunity[];
  contentAngles: string[];
  deduplication?: ResearchDeduplicationSummary;
}

export interface Research {
  publicId: string;
  topic: string | null;
  status: ResearchStatus;
  knowledgePackVersionId: string;
  agentVersion: number;
  providerUsed: string | null;
  modelUsed: string | null;
  tokenUsage: Record<string, unknown> | null;
  generationSettings: Record<string, unknown> | null;
  // Present (and schema-valid) only once status === "COMPLETED" — Module
  // 3's own structured-output guarantee (Phase 3.1's parseStructuredOutput)
  // means this is never a partially-valid or raw-text blob.
  result: ResearchResult | null;
  errorCode: string | null;
  errorMessageSafe: string | null;
  correlationId: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}
