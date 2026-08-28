import "reflect-metadata";
import { IsArray, IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 6 Phase 6.2 — Blog Brief Agent
 * (AI_AGENT_FRAMEWORK_V1.0.md Agent Catalog #5 "Blog Agent"; BLOG_
 * AUTOMATION_ENGINE_V1.0.md "1. Content Brief Engine"; FRD FR-BLOG-001).
 *
 * Lives in packages/shared for the same reason RESEARCH_AGENT_V1 does:
 * apps/api and apps/worker each register their own AgentRegistry but
 * MUST register the exact same AgentDefinition object.
 *
 * FR-BLOG-001 AC: "Brief includes primary + secondary keywords, target
 * audience, CTA objective." The US also names search intent. The output
 * schema below carries ONLY those fields (plus a short rationale for
 * explainability) — nothing the frozen docs don't justify. No AI
 * provider SDK is touched here; execution goes through the existing
 * AIProviderRegistry via the generic ai.execute.v1 worker processor,
 * which already gates ADR-004 (an ACTIVE Knowledge Pack version) for
 * every agent.
 */

export const SEARCH_INTENTS = ["informational", "commercial", "transactional", "navigational"] as const;
export type BlogSearchIntent = (typeof SEARCH_INTENTS)[number];

export class BlogBriefAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  /** Optional caller hints — the agent refines/derives the real values
   * but honours a supplied one where sensible. */
  @IsOptional()
  @IsString()
  targetAudience?: string;

  @IsOptional()
  @IsString()
  primaryKeyword?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondaryKeywords?: string[];

  @IsOptional()
  @IsIn(SEARCH_INTENTS)
  searchIntent?: BlogSearchIntent;

  /** The CTA / business objective this article should drive toward. */
  @IsOptional()
  @IsString()
  businessObjective?: string;
}

export class BlogBriefAgentOutput {
  @IsIn(SEARCH_INTENTS)
  searchIntent!: BlogSearchIntent;

  @IsString()
  @MinLength(1)
  targetAudience!: string;

  @IsString()
  @MinLength(1)
  primaryKeyword!: string;

  @IsArray()
  @IsString({ each: true })
  secondaryKeywords!: string[];

  /** The concrete call-to-action objective (FR-BLOG-001: "CTA objective"). */
  @IsString()
  @MinLength(1)
  ctaObjective!: string;

  /** One or two sentences: why this angle/audience/keyword set, grounded
   * in the topic and the Knowledge Pack context — explainability, not a
   * new frozen field. */
  @IsString()
  @MinLength(1)
  rationale!: string;
}

function buildPrompt(input: BlogBriefAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const keywordSets = context.keywords as { name: string; keywords: string[] }[];
  const packKeywords = keywordSets.length > 0 ? keywordSets.map((k) => `- ${k.name}: ${k.keywords.join(", ")}`).join("\n") : "";
  const brand = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";

  const systemInstructions = [
    "You are the Blog Brief Agent for an EV (electric vehicle) content platform.",
    "You produce a tight content brief that a writer and an outline agent will build from: search intent, target audience, one primary keyword, a short list of secondary keywords, and the call-to-action objective.",
    "Ground every choice in the given topic and the Knowledge Pack context below. Do NOT invent search-volume, CPC, or competition numbers — you have no access to real search data here.",
    "If the caller supplied a primary keyword, target audience, search intent, or objective, honour it unless it is clearly wrong for the topic; otherwise derive the best value.",
    "",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
    context.publishingStrategy && Object.keys(context.publishingStrategy).length > 0 ? `PUBLISHING STRATEGY: ${JSON.stringify(context.publishingStrategy)}` : "",
    packKeywords ? `KNOWLEDGE PACK KEYWORD SETS (use as a seed, not your only source):\n${packKeywords}` : "",
    brand ? `BRAND GUIDELINES: ${brand}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Blog topic: ${input.topic}`,
    input.targetAudience ? `Caller-suggested target audience: ${input.targetAudience}` : "",
    input.primaryKeyword ? `Caller-suggested primary keyword: ${input.primaryKeyword}` : "",
    input.secondaryKeywords && input.secondaryKeywords.length > 0 ? `Caller-suggested secondary keywords: ${input.secondaryKeywords.join(", ")}` : "",
    input.searchIntent ? `Caller-suggested search intent: ${input.searchIntent}` : "",
    input.businessObjective ? `Business objective / desired CTA: ${input.businessObjective}` : "",
    "",
    "Respond with a single JSON object matching BlogBriefAgentOutput exactly: searchIntent (one of " +
      SEARCH_INTENTS.join(" / ") +
      "), targetAudience, primaryKeyword, secondaryKeywords (array), ctaObjective, rationale.",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const BLOG_BRIEF_AGENT_V1: AgentDefinition<BlogBriefAgentInput, BlogBriefAgentOutput> = {
  identifier: "blog-brief-agent",
  version: 1,
  purpose: "Produces a structured blog content brief (search intent, audience, primary/secondary keywords, CTA objective) grounded in the topic and the active Knowledge Pack — FR-BLOG-001.",
  type: "content-generation",
  requiredKnowledgePackCapability: "industry_profile",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: BlogBriefAgentInput,
  outputSchema: BlogBriefAgentOutput,
  buildPrompt,
  // No frozen FRD §21.1 figure exists for brief generation (only Blog
  // draft = 5 min and SEO pass = 3 min are frozen). 2 min is a
  // documented implementation default, well under the ai.execute.v1
  // manifest ceiling.
  timeoutMs: 120_000,
  executionPolicy: { maxAttempts: 3 },
};
