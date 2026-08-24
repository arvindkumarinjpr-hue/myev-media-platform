import type { AgentContext } from "@myev/shared";
import type { KnowledgePackWithChildren } from "../knowledge-packs/knowledge-packs.service";

/**
 * Module 3 Phase 3.2 — the Knowledge Pack → Agent Context boundary
 * (Part 6 of Phase 3.2's own spec). The only place a Knowledge Pack
 * Prisma entity is read anywhere in the Agent Framework — everything
 * downstream (AgentExecutor, provider adapters) only ever sees the
 * plain-data AgentContext this function returns, never `pack` itself or
 * any of its FKs/lock_version/lineage fields.
 *
 * A pure function, not an injectable service — it has no dependencies of
 * its own beyond its single argument.
 */
export function buildAgentContext(pack: KnowledgePackWithChildren): AgentContext {
  return {
    workspaceId: pack.workspaceId,
    knowledgePackVersionId: pack.publicId,
    industryProfile: pack.industryProfile as Record<string, unknown>,
    publishingStrategy: pack.publishingStrategy as Record<string, unknown>,
    trustedSources: pack.knowledgeSources.map((source) => ({
      sourceType: source.sourceType,
      url: source.url,
    })),
    promptTemplates: pack.promptTemplates.map((template) => ({
      contentType: template.contentType,
      promptBody: template.promptBody,
      versionNumber: template.versionNumber,
    })),
    seoRules: pack.seoRules.map((rule) => ({
      primaryKeywords: rule.primaryKeywords,
      secondaryKeywords: rule.secondaryKeywords,
      internalLinkingPolicy: rule.internalLinkingPolicy,
      schemaPreferences: rule.schemaPreferences,
    })),
    brandGuidelines: pack.brandGuidelines.map((guideline) => ({
      toneOfVoice: guideline.toneOfVoice,
      terminology: guideline.terminology,
      ctaRules: guideline.ctaRules,
    })),
    keywords: pack.keywordSets.map((set) => ({
      name: set.name,
      keywords: set.keywords,
    })),
    competitors: pack.competitors.map((competitor) => ({
      domain: competitor.domain,
      notes: competitor.notes,
    })),
  };
}
