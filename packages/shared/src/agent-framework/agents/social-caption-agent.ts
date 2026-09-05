import "reflect-metadata";
import { IsIn, IsOptional, IsString, MinLength } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 10 Phase 10.2 — Social Caption Agent.
 *
 * Generates the caption (and an optional CTA objective, never a fabricated
 * destination URL) for a social post derived from an ALREADY-APPROVED
 * Blog or Video source (SocialGenerationService enforces that eligibility
 * before this agent ever runs — see social-domain.ts's own
 * assertSocialSourceEligible). Platform-specific tone/length guidance is
 * expressed as prompt instructions, not a hardcoded character limit — the
 * checkpoint's own instruction is explicit: "Do not invent current
 * platform character limits."
 */

export class SocialCaptionAgentInput {
  @IsIn(["BLOG", "VIDEO"])
  sourceContentType!: "BLOG" | "VIDEO";

  @IsString()
  @MinLength(1)
  sourceTitle!: string;

  /** The approved source's own content/summary — never re-derived by this agent. */
  @IsString()
  @MinLength(1)
  sourceSummary!: string;

  @IsIn(["FACEBOOK", "INSTAGRAM"])
  platform!: "FACEBOOK" | "INSTAGRAM";
}

export class SocialCaptionAgentOutput {
  @IsString()
  @MinLength(1)
  caption!: string;

  /** Textual only — never a URL. postProcessOutput below rejects one. */
  @IsOptional()
  @IsString()
  ctaObjective?: string;
}

function buildPrompt(input: SocialCaptionAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const brandGuidelines = context.brandGuidelines.length > 0 ? JSON.stringify(context.brandGuidelines) : "";
  const publishingStrategy = context.publishingStrategy && Object.keys(context.publishingStrategy).length > 0 ? JSON.stringify(context.publishingStrategy) : "";

  const systemInstructions = [
    "You are the Social Caption Agent for an EV (electric vehicle) content platform.",
    `Given an already-approved ${input.sourceContentType === "BLOG" ? "blog article" : "video"}, write a single social media caption for ${input.platform} that repurposes it — never a summary of a summary, but a genuine standalone caption someone would actually post.`,
    "Write in the brand's own tone of voice and terminology. Do not fabricate facts, statistics, or claims not present in the source. Do not fabricate or include any URL — no destination link exists yet. Do not claim the content is already published anywhere.",
    "An optional ctaObjective may describe the intent of a call to action in plain text (e.g. \"drive comments asking about range\") — never a URL, never fabricated.",
    brandGuidelines ? `KNOWLEDGE PACK BRAND GUIDELINES: ${brandGuidelines}` : "",
    publishingStrategy ? `KNOWLEDGE PACK PUBLISHING STRATEGY: ${publishingStrategy}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Source type: ${input.sourceContentType}`,
    `Source title: ${input.sourceTitle}`,
    `Source summary: ${input.sourceSummary}`,
    `Target platform: ${input.platform}`,
    "",
    "Respond with a single JSON object matching SocialCaptionAgentOutput exactly: caption (string), ctaObjective (optional string, plain text, never a URL).",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

const URL_PATTERN = /https?:\/\/|www\./i;

/**
 * Deterministic structural check the class-validator decorators can't
 * express: ctaObjective must never be (or contain) a URL — the checkpoint's
 * own "No fabricated destination URL" rule, enforced the same way
 * SeoMetadataAgent's postProcessOutput enforces its own structural
 * constraint (throw => job fails safely, never "repaired").
 */
function postProcessOutput(output: SocialCaptionAgentOutput): SocialCaptionAgentOutput {
  if (output.ctaObjective && URL_PATTERN.test(output.ctaObjective)) {
    throw new Error("SocialCaptionAgent ctaObjective must not contain a URL — no destination link exists at generation time.");
  }
  return output;
}

export const SOCIAL_CAPTION_AGENT_V1: AgentDefinition<SocialCaptionAgentInput, SocialCaptionAgentOutput> = {
  identifier: "social-caption-agent",
  version: 1,
  purpose: "Generates a platform-aware social caption (and optional CTA objective) from an already-approved Blog or Video source — Module 10 Phase 10.2.",
  type: "content-generation",
  requiredKnowledgePackCapability: "brand_guidelines",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: SocialCaptionAgentInput,
  outputSchema: SocialCaptionAgentOutput,
  buildPrompt,
  postProcessOutput,
  timeoutMs: 120_000,
  executionPolicy: { maxAttempts: 3 },
};
