import "reflect-metadata";
import { Type } from "class-transformer";
import { IsArray, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 4 Phase 4.1 — the first real production business agent
 * (AI_AGENT_FRAMEWORK_V1.0.md's Agent Catalog #1, FRD §7 Research
 * Engine). Lives in packages/shared, not apps/api or apps/worker, for
 * the identical reason AI_EXECUTE_V1_MANIFEST does: apps/api and
 * apps/worker each register their own AgentRegistry, but both must
 * register the EXACT same AgentDefinition object (same buildPrompt
 * function, same schemas) — a per-process copy would risk silent drift.
 * test-agent.ts's own "no production content agent is defined here"
 * scope note is about that one file, not a rule against any real agent
 * living in packages/shared.
 */

/** A single Knowledge Pack trusted source, already reachability-checked at Research submission time (apps/api's ResearchService) — never re-checked here, never fetched live during prompt construction (buildPrompt is synchronous, by Module 3's own AgentDefinition contract). */
export class VerifiedSourceInput {
  @IsString()
  url!: string;

  @IsString()
  sourceType!: string;

  reachable!: boolean;
}

export class ResearchAgentInput {
  @IsString()
  topic!: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsString()
  geography?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  seedKeywords?: string[];

  // Populated by ResearchService.submit() from a real
  // ResearchSourceProvider reachability check (FR-RES-002) — never
  // supplied directly by an API caller (CreateResearchDto has no such
  // field); present here only so buildPrompt can read it from a single,
  // already-validated input object.
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VerifiedSourceInput)
  verifiedSources!: VerifiedSourceInput[];
}

export class ResearchFinding {
  @IsString()
  summary!: string;

  @IsOptional()
  @IsString()
  evidence?: string;

  // Must be a subset of the request's own verifiedSources[].url —
  // buildPrompt's own system instructions forbid citing anything else;
  // this is the structural half of "never fabricate citations" (the
  // instructional half lives in the prompt itself).
  @IsArray()
  @IsString({ each: true })
  sourceUrls!: string[];
}

export class ResearchSourceOutput {
  @IsString()
  url!: string;

  @IsString()
  sourceType!: string;

  @IsOptional()
  @IsString()
  title?: string;
}

export class TrendSignal {
  @IsString()
  topic!: string;

  @IsIn(["rising", "steady", "declining"])
  direction!: "rising" | "steady" | "declining";

  @IsInt()
  @Min(0)
  @Max(100)
  confidence!: number;

  // FR-RES's own evidence-basis requirement (Part 7 of this phase's own
  // spec: "do not call something trending merely because the LLM says it
  // is") — every signal must name what in the given sources/context
  // supports it, not just assert a direction.
  @IsString()
  evidence!: string;
}

export class KeywordOpportunity {
  @IsString()
  keyword!: string;

  @IsIn(["informational", "transactional", "navigational", "unknown"])
  intent!: "informational" | "transactional" | "navigational" | "unknown";

  // FR-KW-003: 0-100, explainable — rationale is mandatory, not optional,
  // so the score is never a black box.
  @IsInt()
  @Min(0)
  @Max(100)
  opportunityScore!: number;

  @IsString()
  rationale!: string;
}

export class ResearchAgentOutput {
  @IsString()
  executiveSummary!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResearchFinding)
  findings!: ResearchFinding[];

  // The exact sources actually used — a subset of (never additions to)
  // the request's own verifiedSources. Persisted for citation/provenance
  // display; never fabricated URLs.
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResearchSourceOutput)
  sources!: ResearchSourceOutput[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrendSignal)
  trendSignals!: TrendSignal[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeywordOpportunity)
  keywordOpportunities!: KeywordOpportunity[];

  @IsArray()
  @IsString({ each: true })
  contentAngles!: string[];
}

function buildPrompt(input: ResearchAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const reachable = input.verifiedSources.filter((s) => s.reachable);
  const sourceList = reachable.length > 0 ? reachable.map((s) => `- [${s.sourceType}] ${s.url}`).join("\n") : "(none reachable — state this plainly in the executive summary, do not invent one)";

  const systemInstructions = [
    "You are the Research Agent for an EV (electric vehicle) content platform.",
    "You produce structured research intelligence: an executive summary, findings, trend signals, and keyword opportunities.",
    "CRITICAL — citation integrity: you may cite ONLY the exact URLs listed below under VERIFIED SOURCES. Never invent, guess, or hallucinate a URL. Every entry in findings[].sourceUrls and sources[] must be one of these exact URLs, verbatim. If none are reachable, say so in executiveSummary and leave findings[].sourceUrls / sources[] empty rather than fabricating one.",
    "CRITICAL — trend integrity: every trendSignals[] entry must name concrete evidence for its direction (from the sources or the given context) in its own evidence field. Never assert a trend has no basis beyond your own impression.",
    "CRITICAL — keyword integrity: opportunityScore must be explainable — always fill in rationale. Do not invent search volume, CPC, or competition metrics; you have no access to real search data in this context.",
    "",
    "VERIFIED SOURCES (the ONLY citable URLs):",
    sourceList,
    "",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
    context.competitors.length > 0 ? `KNOWN COMPETITORS: ${context.competitors.map((c) => c.domain).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Research topic: ${input.topic}`,
    input.objective ? `Objective: ${input.objective}` : "",
    input.geography ? `Geography: ${input.geography}` : "",
    input.language ? `Language: ${input.language}` : "",
    input.seedKeywords && input.seedKeywords.length > 0 ? `Seed keywords to consider: ${input.seedKeywords.join(", ")}` : "",
    "",
    "Respond with a single JSON object matching the required ResearchAgentOutput schema exactly: executiveSummary, findings, sources, trendSignals, keywordOpportunities, contentAngles.",
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

export const RESEARCH_AGENT_V1: AgentDefinition<ResearchAgentInput, ResearchAgentOutput> = {
  identifier: "research-agent",
  version: 1,
  purpose: "Produces structured research intelligence (findings, trend signals, keyword opportunities) for a topic, grounded only in the workspace's own Knowledge-Pack-configured trusted sources — never fabricated citations.",
  type: "research",
  requiredKnowledgePackCapability: "trusted_sources",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: ResearchAgentInput,
  outputSchema: ResearchAgentOutput,
  buildPrompt,
  // Research synthesizes across multiple sources and a larger structured
  // output than the 5s test agents ever needed — generous relative to
  // those, but MUST stay under the durable ai.execute.v1 job manifest's
  // own hard-enforced 30s `timeout` (packages/shared/src/queue/jobs/
  // ai-execute.ts — BullMqWorkerManager races every handler against
  // exactly that value and kills it on expiry, independent of whatever
  // this AbortController does). 25s leaves a safety margin under it.
  timeoutMs: 25_000,
  executionPolicy: { maxAttempts: 3 },
};
