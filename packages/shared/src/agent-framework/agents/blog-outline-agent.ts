import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsIn, IsInt, IsString, Max, Min, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";
import { SEARCH_INTENTS, type BlogSearchIntent } from "./blog-brief-agent";

/**
 * Module 6 Phase 6.2 — Blog Outline Agent
 * (BLOG_AUTOMATION_ENGINE_V1.0.md "2. Outline Engine": H1/H2/H3
 * structure, FAQ planning, key talking points; FRD FR-BLOG-002).
 *
 * Input is the APPROVED brief (search intent, audience, keywords, CTA
 * objective) plus the topic — Phase 6.2 defines the agent contract; the
 * "outline must be approved before it is used" quality gate is Phase 6.3
 * orchestration, not enforced here.
 */

export class BlogOutlineAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

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

  @IsString()
  @MinLength(1)
  ctaObjective!: string;
}

export class BlogOutlineSection {
  /** H2 or H3 — the H1 is a separate top-level field. */
  @IsInt()
  @Min(2)
  @Max(3)
  level!: number;

  @IsString()
  @MinLength(1)
  heading!: string;

  /** What this section is for — the "section intent/purpose" the writer
   * and draft agent need. */
  @IsString()
  @MinLength(1)
  purpose!: string;
}

export class BlogOutlineAgentOutput {
  @IsString()
  @MinLength(1)
  h1!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BlogOutlineSection)
  sections!: BlogOutlineSection[];

  /** Planned FAQ questions (BLOG_AUTOMATION_ENGINE "FAQ planning"). May
   * be empty for a topic where an FAQ genuinely doesn't fit. */
  @IsArray()
  @IsString({ each: true })
  faqPlan!: string[];
}

function buildPrompt(input: BlogOutlineAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const seoRules = context.seoRules.length > 0 ? JSON.stringify(context.seoRules) : "";

  const systemInstructions = [
    "You are the Blog Outline Agent for an EV (electric vehicle) content platform.",
    "Given an approved content brief, produce the article's skeleton: one H1, an ordered list of H2/H3 sections (each with a heading and a one-line purpose), and a list of planned FAQ questions.",
    "The outline must reflect the brief's search intent, primary keyword, and CTA objective. Order sections so a reader moves logically from context to detail to next step.",
    "Do not write article prose here — only headings and purposes.",
    seoRules ? `KNOWLEDGE PACK SEO RULES: ${seoRules}` : "",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Search intent: ${input.searchIntent}`,
    `Target audience: ${input.targetAudience}`,
    `Primary keyword: ${input.primaryKeyword}`,
    input.secondaryKeywords.length > 0 ? `Secondary keywords: ${input.secondaryKeywords.join(", ")}` : "",
    `CTA objective: ${input.ctaObjective}`,
    "",
    "Respond with a single JSON object matching BlogOutlineAgentOutput exactly: h1, sections (array of { level: 2 or 3, heading, purpose }), faqPlan (array of question strings).",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const BLOG_OUTLINE_AGENT_V1: AgentDefinition<BlogOutlineAgentInput, BlogOutlineAgentOutput> = {
  identifier: "blog-outline-agent",
  version: 1,
  purpose: "Produces a blog article outline (H1, ordered H2/H3 sections with purposes, FAQ plan) from an approved content brief — FR-BLOG-002.",
  type: "content-generation",
  requiredKnowledgePackCapability: "seo_rules",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: BlogOutlineAgentInput,
  outputSchema: BlogOutlineAgentOutput,
  buildPrompt,
  // No frozen FRD §21.1 figure for outline generation — documented
  // implementation default, under the ai.execute.v1 manifest ceiling.
  timeoutMs: 120_000,
  executionPolicy: { maxAttempts: 3 },
};
