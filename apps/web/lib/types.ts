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

// Module 4 Phase 4.3 (FR-RES-002) — sourceIds reference ResearchSource.sourceId,
// never a raw URL (RESEARCH_AGENT_V1's own postProcessOutput hook
// structurally rejects anything else). provenance distinguishes a
// finding backed by a real, verified citation from the model's own
// unsupported inference — not a claim that the specific fact is
// independently fact-checked.
export interface ResearchFinding {
  summary: string;
  evidence?: string;
  sourceIds: string[];
  provenance?: "source_backed" | "ai_inference";
}

export interface ResearchSource {
  sourceId?: string;
  url: string;
  sourceType: string;
  title?: string;
}

// Module 4 Phase 4.4 (FR-RES-001) — opportunityScore (how actionable for
// content planning, distinct from `confidence`) and freshness (topic
// novelty/age, distinct from `direction`'s momentum) are both required
// by the frozen AC: "Trend Agent returns topic + opportunity score +
// freshness."
export interface TrendSignal {
  topic: string;
  direction: "rising" | "steady" | "declining";
  confidence: number;
  evidence: string;
  opportunityScore: number;
  freshness: "new" | "ongoing" | "long-standing";
}

// Module 4 Phase 4.4 (FR-KW-002/003) — per-keyword within a cluster.
export interface KeywordClusterMember {
  keyword: string;
  intent: "informational" | "transactional" | "navigational" | "unknown";
  opportunityScore: number;
  rationale: string;
}

// Module 4 Phase 4.4 (FR-KW-001) — "Output includes primary + secondary
// keyword sets per cluster," replacing the flat KeywordOpportunity[]
// from Phase 4.1-4.3.
export interface KeywordCluster {
  clusterTopic: string;
  primaryKeywords: KeywordClusterMember[];
  secondaryKeywords: KeywordClusterMember[];
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

// Module 4 Phase 4.3 (FR-RES-002) — always present once status ===
// "COMPLETED", same as deduplication above.
export interface ResearchCitationIntegritySummary {
  invalidCitationsRemoved: number;
}

export interface ResearchResult {
  executiveSummary: string;
  findings: ResearchFinding[];
  sources: ResearchSource[];
  trendSignals: TrendSignal[];
  keywordClusters: KeywordCluster[];
  contentAngles: string[];
  deduplication?: ResearchDeduplicationSummary;
  citationIntegrity?: ResearchCitationIntegritySummary;
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
