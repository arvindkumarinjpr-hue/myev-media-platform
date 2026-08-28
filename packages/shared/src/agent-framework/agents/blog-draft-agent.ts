import "reflect-metadata";
import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsInt, IsString, Max, Min, MinLength, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 6 Phase 6.2 — Blog Draft Agent
 * (BLOG_AUTOMATION_ENGINE_V1.0.md "3. Draft Engine": introduction, body
 * sections, examples, conclusion, CTA; FRD FR-BLOG-003).
 *
 * Input is the APPROVED outline plus the brief context. Phase 6.2
 * defines the agent contract; the "outline approved (Quality Gate #2)"
 * precondition is Phase 6.3 orchestration.
 *
 * FRD §21.1 frozen timeout — "Queue job timeout — Blog draft generation
 * | 5 min" — applied as `timeoutMs: 300_000` below (and the reason the
 * ai.execute.v1 manifest ceiling was raised to match, Phase 6.2).
 */

export class BlogDraftOutlineSection {
  @IsInt()
  @Min(2)
  @Max(3)
  level!: number;

  @IsString()
  @MinLength(1)
  heading!: string;

  @IsString()
  @MinLength(1)
  purpose!: string;
}

export class BlogDraftAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  @IsString()
  @MinLength(1)
  h1!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BlogDraftOutlineSection)
  sections!: BlogDraftOutlineSection[];

  @IsArray()
  @IsString({ each: true })
  faqPlan!: string[];

  @IsString()
  @MinLength(1)
  primaryKeyword!: string;

  @IsArray()
  @IsString({ each: true })
  secondaryKeywords!: string[];

  @IsString()
  @MinLength(1)
  targetAudience!: string;

  @IsString()
  @MinLength(1)
  ctaObjective!: string;
}

export class BlogDraftBodySection {
  @IsInt()
  @Min(2)
  @Max(3)
  level!: number;

  @IsString()
  @MinLength(1)
  heading!: string;

  /** The written prose for this section — may include inline examples
   * (BLOG_AUTOMATION_ENGINE "examples"). */
  @IsString()
  @MinLength(1)
  content!: string;
}

export class BlogDraftFaq {
  @IsString()
  @MinLength(1)
  question!: string;

  @IsString()
  @MinLength(1)
  answer!: string;
}

export class BlogDraftAgentOutput {
  @IsString()
  @MinLength(1)
  introduction!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BlogDraftBodySection)
  bodySections!: BlogDraftBodySection[];

  @IsString()
  @MinLength(1)
  conclusion!: string;

  @IsString()
  @MinLength(1)
  cta!: string;

  /** Answered FAQs, derived from the outline's faqPlan. May be empty
   * when the plan was empty. */
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BlogDraftFaq)
  faqs!: BlogDraftFaq[];
}

function buildPrompt(input: BlogDraftAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const brand = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";
  const outline = input.sections.map((s) => `${"  ".repeat(s.level - 2)}H${s.level} ${s.heading} — ${s.purpose}`).join("\n");

  const systemInstructions = [
    "You are the Blog Draft Agent for an EV (electric vehicle) content platform.",
    "Write a complete first draft from the approved outline: an introduction, one prose block per outline section (keeping the exact heading and level), a conclusion, a call-to-action, and answers to every planned FAQ question.",
    "Use the primary keyword naturally in the introduction and at least one heading's section; work in secondary keywords where they fit. Write for the stated target audience. Include concrete examples where they help.",
    "Do not invent statistics, prices, or quotes. Do not add sections that are not in the outline. Do not include SEO meta tags or a schema block — that is a separate step.",
    brand ? `BRAND GUIDELINES (tone, terminology, CTA rules): ${brand}` : "",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `H1: ${input.h1}`,
    `Target audience: ${input.targetAudience}`,
    `Primary keyword: ${input.primaryKeyword}`,
    input.secondaryKeywords.length > 0 ? `Secondary keywords: ${input.secondaryKeywords.join(", ")}` : "",
    `CTA objective: ${input.ctaObjective}`,
    "",
    "Approved outline:",
    outline,
    "",
    input.faqPlan.length > 0 ? `Planned FAQ questions to answer:\n${input.faqPlan.map((q) => `- ${q}`).join("\n")}` : "No FAQ planned — return an empty faqs array.",
    "",
    "Respond with a single JSON object matching BlogDraftAgentOutput exactly: introduction, bodySections (array of { level, heading, content }), conclusion, cta, faqs (array of { question, answer }).",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const BLOG_DRAFT_AGENT_V1: AgentDefinition<BlogDraftAgentInput, BlogDraftAgentOutput> = {
  identifier: "blog-draft-agent",
  version: 1,
  purpose: "Generates a full blog article draft (introduction, body sections, conclusion, CTA, answered FAQs) from an approved outline — FR-BLOG-003.",
  type: "content-generation",
  requiredKnowledgePackCapability: "brand_guidelines",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: BlogDraftAgentInput,
  outputSchema: BlogDraftAgentOutput,
  buildPrompt,
  // FROZEN — FRD §21.1 "Queue job timeout — Blog draft generation | 5 min".
  timeoutMs: 300_000,
  executionPolicy: { maxAttempts: 3 },
};
