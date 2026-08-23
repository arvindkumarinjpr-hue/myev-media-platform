/**
 * Module 3 Phase 3.2 — the provider-neutral Agent context
 * (AI_AGENT_FRAMEWORK_V1.0.md "Shared Context": Workspace, Project,
 * Knowledge Pack, Brand Rules, User Preferences, Previous Content
 * References).
 *
 * This is the boundary between Knowledge Pack (a Module 2 Prisma entity
 * apps/api owns) and everything downstream: a Context Builder
 * (apps/api, Prisma-aware) maps a resolved KnowledgePackWithChildren
 * snapshot into exactly this shape; the AgentExecutor and every provider
 * adapter only ever see this plain-data shape, never a Knowledge Pack
 * Prisma model or its internal FKs/lock_version/lineage fields. Keeps
 * the boundary Knowledge Pack → Agent Context Builder → Agent Runtime →
 * AI Provider intact.
 */
export interface AgentContext {
  workspaceId: string;
  /** The exact Knowledge Pack version's public id this context was built from. */
  knowledgePackVersionId: string;

  industryProfile: Record<string, unknown>;
  publishingStrategy: Record<string, unknown>;

  trustedSources: Record<string, unknown>[];
  promptTemplates: Record<string, unknown>[];
  seoRules: Record<string, unknown>[];
  brandGuidelines: Record<string, unknown>[];
  keywords: Record<string, unknown>[];
  competitors: Record<string, unknown>[];
}
