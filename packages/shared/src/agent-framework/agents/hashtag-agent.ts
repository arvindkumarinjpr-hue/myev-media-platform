import "reflect-metadata";
import { ArrayMinSize, IsArray, IsIn, IsString, MinLength } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 10 Phase 10.2 — Hashtag Agent.
 *
 * Runs AFTER SocialCaptionAgent, over the generated caption — never over
 * VideoScript.tags (checkpoint's own explicit prohibition: hashtags are a
 * social-specific artifact, not a repurposed video tag) and never using
 * Module 8 internal-link data (a different, unrelated content-relationship
 * concept). Returns a structured array — never a single comma-separated
 * string (checkpoint's own explicit prohibition). Normalization/
 * deduplication happens deterministically in SocialGenerationService
 * AFTER schema validation, not inside the agent itself — keeps the agent
 * a pure "what hashtags fit" generator, and the normalization rule
 * (lowercase dedupe, `#`-prefix enforcement) independently unit-testable
 * without a provider call.
 */

export class HashtagAgentInput {
  @IsString()
  @MinLength(1)
  sourceSummary!: string;

  @IsString()
  @MinLength(1)
  caption!: string;

  @IsIn(["FACEBOOK", "INSTAGRAM"])
  platform!: "FACEBOOK" | "INSTAGRAM";
}

export class HashtagAgentOutput {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  hashtags!: string[];
}

function buildPrompt(input: HashtagAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const terminology = context.brandGuidelines.flatMap((g) => (g.terminology as string[] | undefined) ?? []);
  const brandTerms = terminology.length > 0 ? terminology.join(", ") : "";

  const systemInstructions = [
    "You are the Hashtag Agent for an EV (electric vehicle) content platform.",
    `Given a social caption for ${input.platform}, produce a short list of relevant hashtags. Each hashtag must start with "#", contain no spaces, and be relevant to the caption's actual subject.`,
    "Do not invent a platform hashtag-count limit — return however many are genuinely relevant, typically a handful. Do not optimize based on analytics you were not given.",
    brandTerms ? `Prefer brand terminology where it fits naturally: ${brandTerms}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Source summary: ${input.sourceSummary}`,
    `Caption: ${input.caption}`,
    `Target platform: ${input.platform}`,
    "",
    'Respond with a single JSON object matching HashtagAgentOutput exactly: hashtags (array of strings, each starting with "#").',
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const HASHTAG_AGENT_V1: AgentDefinition<HashtagAgentInput, HashtagAgentOutput> = {
  identifier: "hashtag-agent",
  version: 1,
  purpose: "Generates a structured, platform-aware hashtag list from a generated social caption — Module 10 Phase 10.2.",
  type: "content-generation",
  requiredKnowledgePackCapability: "brand_guidelines",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: HashtagAgentInput,
  outputSchema: HashtagAgentOutput,
  buildPrompt,
  timeoutMs: 60_000,
  executionPolicy: { maxAttempts: 3 },
};

/**
 * Deterministic normalization applied by SocialGenerationService (not the
 * agent's own postProcessOutput — this must survive independent of any
 * one provider call and be identically testable without a provider).
 * Lowercases for dedup comparison only (original casing is preserved in
 * the kept occurrence), strips internal whitespace, enforces a single
 * leading "#", and drops empties — deterministic, no fabricated ranking.
 */
export function normalizeHashtags(raw: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of raw) {
    const trimmed = value.trim().replace(/\s+/g, "");
    if (trimmed.length <= 1) continue;
    const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    const key = withHash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(withHash);
  }
  return result;
}
