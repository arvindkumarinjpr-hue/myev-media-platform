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

// Module 5 Phase 5.1 (FR-PLAN-002) — mirrors TopicClustersController's
// own serialize() shape exactly. A persisted keyword row (real relational
// data, DB Design §5.8) — distinct from Research's own in-flight
// KeywordClusterMember (which never leaves ai_jobs.output_payload).
export interface PersistedKeyword {
  term: string;
  searchIntent: "INFORMATIONAL" | "TRANSACTIONAL" | "NAVIGATIONAL" | "UNKNOWN";
  opportunityScore: number;
  rationale: string;
}

export interface TopicCluster {
  publicId: string;
  name: string;
  clusterTopic: string;
  primaryKeywords: PersistedKeyword[];
  secondaryKeywords: PersistedKeyword[];
  sourceResearchId: string;
  knowledgePackVersionId: string;
  contentSeries: { publicId: string; name: string } | null;
  createdAt: string;
}

// Module 5 Phase 5.1 — mirrors ContentSeriesController's own serialize()
// shape (Module 1E), reused as-is for the topic-cluster creation flow's
// own "select or create a series" step.
export interface ContentSeries {
  publicId: string;
  projectId: string | null;
  name: string;
  createdAt: string;
  updatedAt: string;
}

// Module 6 Phase 6.4 — mirrors BlogController / BlogPipelineService
// serialize shapes exactly (Phase 6.3 read model + Phase 6.4 Blog-facing
// score read). The per-item pipeline state lives in
// content_items.metadata.blogPipeline on the backend; the frontend only
// ever consumes the serialized read model.

export type ContentItemStatus = "DRAFT" | "IN_PROGRESS" | "REVIEW" | "APPROVED" | "ARCHIVED" | "DELETED" | "RENDERING" | "FAILED" | "SCHEDULED" | "PUBLISHED";

export type BlogGenerationStageStatus = "PENDING" | "GENERATING" | "READY" | "APPROVED" | "FAILED";
export type BlogDeterministicStageStatus = "PENDING" | "COMPLETED";

export type BlogPipelineStage =
  | "BRIEF"
  | "OUTLINE"
  | "DRAFT"
  | "SEO"
  | "INTERNAL_LINKING"
  | "QA"
  | "SCORING"
  | "READY_FOR_REVIEW"
  | "IN_REVIEW"
  | "APPROVED"
  | "PUBLISH_READY";

export type BlogSearchIntent = "informational" | "commercial" | "transactional" | "navigational";

export interface BlogBriefArtifact {
  searchIntent: BlogSearchIntent;
  targetAudience: string;
  primaryKeyword: string;
  secondaryKeywords: string[];
  ctaObjective: string;
  rationale: string;
}

export interface BlogOutlineSection {
  level: number;
  heading: string;
  purpose: string;
}
export interface BlogOutlineArtifact {
  h1: string;
  sections: BlogOutlineSection[];
  faqPlan: string[];
}

export interface BlogSeoArtifact {
  metaTitle: string;
  metaDescription: string;
  urlSlug: string;
  schemaMarkup: Record<string, unknown>;
}

export interface BlogGenerationStage<A> {
  status: BlogGenerationStageStatus;
  aiJobPublicId: string | null;
  artifact: A | null;
  approvedAt?: string | null;
  failureReason: string | null;
}

export interface BlogDraftFaq {
  question: string;
  answer: string;
}
export interface BlogDraftBodySection {
  level: number;
  heading: string;
  content: string;
}
export interface BlogDraftArtifact {
  introduction: string;
  bodySections: BlogDraftBodySection[];
  conclusion: string;
  cta: string;
  faqs: BlogDraftFaq[];
}

export interface BlogDraftStage {
  status: BlogGenerationStageStatus;
  aiJobPublicId: string | null;
  contentVersionPublicId: string | null;
  artifact: BlogDraftArtifact | null;
  pendingFinalization: boolean;
  failureReason: string | null;
}

export interface BlogSeoStage {
  status: BlogGenerationStageStatus;
  aiJobPublicId: string | null;
  blogArticlePublicId: string | null;
  artifact: BlogSeoArtifact | null;
  pendingFinalization: boolean;
  failureReason: string | null;
}

export interface BlogInternalLinkingStage {
  status: BlogDeterministicStageStatus;
  suggestions: { targetContentItemPublicId: string; anchorText: string; reason: string }[];
  reason: "engine_not_available" | "no_related_content_found" | "suggestions_generated";
  completedAt: string | null;
}

export type BlogQaCheckId = "grammar" | "readability" | "structure_headings" | "keyword_stuffing" | "duplicate_content" | "brand_compliance";

export interface BlogQaCheck {
  id: BlogQaCheckId;
  label: string;
  passed: boolean;
  explanation: string;
  evidence: string[];
}

export interface BlogQaStage {
  status: BlogDeterministicStageStatus;
  checks: BlogQaCheck[];
  completedAt: string | null;
}

export interface BlogScoringStage {
  status: BlogDeterministicStageStatus;
  contentScorePublicId: string | null;
  overallScore: number | null;
  passThreshold: number | null;
  passed: boolean | null;
  ranAt: string | null;
}

export type BlogReviewGate =
  | "brief_approved"
  | "outline_approved"
  | "draft_generated"
  | "seo_complete"
  | "internal_linking_completed"
  | "qa_complete"
  | "content_score_run"
  | "content_score_passed";

export interface BlogPipeline {
  contentItem: { publicId: string; title: string; contentType: string; status: ContentItemStatus };
  knowledgePackVersionId: string;
  currentStage: BlogPipelineStage;
  publishReady: boolean;
  brief: BlogGenerationStage<BlogBriefArtifact>;
  outline: BlogGenerationStage<BlogOutlineArtifact>;
  draft: BlogDraftStage;
  seo: BlogSeoStage;
  internalLinking: BlogInternalLinkingStage;
  qa: BlogQaStage;
  scoring: BlogScoringStage;
  reviewGatesUnmet: BlogReviewGate[];
  canSubmitForReview: boolean;
}

export interface BlogListItem {
  publicId: string;
  title: string;
  status: ContentItemStatus;
  knowledgePackVersionId: string;
  brief: BlogGenerationStageStatus;
  outline: BlogGenerationStageStatus;
  draft: BlogGenerationStageStatus;
  seo: BlogGenerationStageStatus;
  qa: BlogDeterministicStageStatus;
  scoring: { status: BlogDeterministicStageStatus; passed: boolean | null; overallScore: number | null };
}

export type BlogScoreCategory = "SEO" | "VIRAL" | "QUALITY" | "ENGAGEMENT" | "BUSINESS";

export interface BlogScoreFactor {
  id: string;
  category: BlogScoreCategory | null;
  label: string;
  value: number;
  weight: number;
  reason: string;
  evidence?: Record<string, string | number | boolean>;
}
export interface BlogScoreRecommendation {
  id: string;
  priority: "critical" | "high" | "medium" | "low";
  category: BlogScoreCategory | null;
  message: string;
  relatedFactorId?: string;
}

export interface BlogScoreFeedback {
  overallScore: number;
  passThreshold: number;
  passed: boolean;
  categoryScores: Record<BlogScoreCategory, number>;
  dimension: { name: string; version: number; label: string; score: number };
  recommendations: BlogScoreRecommendation[];
  factors: BlogScoreFactor[];
  calculatedAt: string;
}

// Module 1E content version (used for the Draft version history surface).
export interface ContentVersion {
  publicId: string;
  versionNumber: number;
  body: Record<string, unknown>;
  createdAt: string;
}
