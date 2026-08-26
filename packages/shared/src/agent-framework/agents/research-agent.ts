import "reflect-metadata";
import { Type } from "class-transformer";
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from "class-validator";
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

// FR-RES-004 — Research Dataset Deduplication. Populated only by this
// agent's own postProcessOutput hook (below), never by the provider —
// the raw LLM response never includes this field, hence @IsOptional()
// here even though postProcessOutput always fills it in before the
// output is ever persisted.
export class ResearchDeduplicationSummary {
  @IsInt()
  @Min(0)
  duplicateFindingsRemoved!: number;

  @IsInt()
  @Min(0)
  duplicateSourcesRemoved!: number;

  // FR-RES-004's own error condition: "Deduplication failure does not
  // block the job but flags the dataset for manual review." True only
  // when the deterministic dedup pass itself threw — never a comment on
  // the research content's own quality.
  @IsBoolean()
  requiresManualReview!: boolean;

  @IsOptional()
  @IsString()
  reviewReason?: string;
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

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchDeduplicationSummary)
  deduplication?: ResearchDeduplicationSummary;
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

// FR-RES-004 — near-duplicate detection over free text. Deliberately a
// deterministic, explainable token-overlap check (Jaccard similarity on
// normalized word sets) rather than a second LLM call: the FRD's own
// error condition ("deduplication failure does not block the job") only
// makes sense for a step with its own independent, non-AI failure mode,
// and a model-only pass would offer no verifiable guarantee at all.
const DUPLICATE_FINDING_SIMILARITY_THRESHOLD = 0.8;

function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(normalizeForComparison(a).split(" ").filter(Boolean));
  const setB = new Set(normalizeForComparison(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection += 1;
    }
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function deduplicateFindings(findings: ResearchFinding[]): { deduped: ResearchFinding[]; duplicatesRemoved: number } {
  const kept: ResearchFinding[] = [];
  let duplicatesRemoved = 0;
  for (const finding of findings) {
    const isDuplicate = kept.some((k) => jaccardSimilarity(k.summary, finding.summary) >= DUPLICATE_FINDING_SIMILARITY_THRESHOLD);
    if (isDuplicate) {
      duplicatesRemoved += 1;
    } else {
      kept.push(finding);
    }
  }
  return { deduped: kept, duplicatesRemoved };
}

// Sources are deduplicated on exact URL match (a source is either the
// same trusted-source URL or it isn't — no fuzzy matching needed, unlike
// findings' free-text summaries).
function deduplicateSources(sources: ResearchSourceOutput[]): { deduped: ResearchSourceOutput[]; duplicatesRemoved: number } {
  const seen = new Set<string>();
  const deduped: ResearchSourceOutput[] = [];
  let duplicatesRemoved = 0;
  for (const source of sources) {
    if (seen.has(source.url)) {
      duplicatesRemoved += 1;
    } else {
      seen.add(source.url);
      deduped.push(source);
    }
  }
  return { deduped, duplicatesRemoved };
}

// FR-RES-004: "Duplicate detection runs before the research package is
// marked complete" — this runs as this agent's own postProcessOutput
// hook (packages/shared/src/agent-framework/agent-definition.ts), on the
// already schema-validated provider output, before the executor ever
// persists ai_jobs.output_payload or marks the job COMPLETED. Never an
// LLM step, so it is deterministic and reproducible for the same input.
function postProcessOutput(output: ResearchAgentOutput): ResearchAgentOutput {
  try {
    const { deduped: findings, duplicatesRemoved: duplicateFindingsRemoved } = deduplicateFindings(output.findings);
    const { deduped: sources, duplicatesRemoved: duplicateSourcesRemoved } = deduplicateSources(output.sources);
    return {
      ...output,
      findings,
      sources,
      deduplication: { duplicateFindingsRemoved, duplicateSourcesRemoved, requiresManualReview: false },
    };
  } catch {
    // FR-RES-004's own error condition, applied literally: a failure in
    // this deterministic pass must never fail an otherwise-successful
    // research job — the un-deduplicated output is kept and flagged for
    // manual review instead. Never surfaces the raw internal error.
    return {
      ...output,
      deduplication: { duplicateFindingsRemoved: 0, duplicateSourcesRemoved: 0, requiresManualReview: true, reviewReason: "Automated deduplication could not be completed — findings and sources were not deduplicated." },
    };
  }
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
  postProcessOutput,
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
