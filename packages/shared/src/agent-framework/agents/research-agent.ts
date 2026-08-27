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

/**
 * A single Knowledge Pack trusted source, already reachability-checked
 * at Research submission time (apps/api's ResearchService) — never
 * re-checked here, never fetched live during prompt construction
 * (buildPrompt is synchronous, by Module 3's own AgentDefinition
 * contract).
 *
 * Module 4 Phase 4.3 — sourceId is a stable, per-run identifier assigned
 * by ResearchService.submit() (e.g. "S1", "S2"), never derived from or
 * guessable by the model. It is the ONLY thing findings[] may cite
 * (see buildPrompt/postProcessOutput below) — this is what makes source
 * citation structurally enforceable rather than a prompt-only promise:
 * the model can point at an id we handed it, but it cannot invent one
 * that resolves to a real, verified source it was never given.
 */
export class VerifiedSourceInput {
  @IsString()
  sourceId!: string;

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

  // Module 4 Phase 4.3 — references VerifiedSourceInput.sourceId, never
  // a raw URL. postProcessOutput (below) structurally validates every
  // entry against the request's own verified source-ID set and drops
  // anything unrecognized — the model cannot "promote" an arbitrary
  // string into a verified citation merely by writing it here.
  @IsArray()
  @IsString({ each: true })
  sourceIds!: string[];

  // Computed by postProcessOutput, never model-authored (hence
  // @IsOptional — the raw LLM response never includes it). Distinguishes
  // "this finding cites at least one real, verified source" from
  // "this is the model's own unsupported inference" — NOT a claim that
  // the specific fact stated has been independently fact-checked.
  @IsOptional()
  @IsIn(["source_backed", "ai_inference"])
  provenance?: "source_backed" | "ai_inference";
}

export class ResearchSourceOutput {
  // Module 4 Phase 4.3 — cross-references ResearchFinding.sourceIds so
  // the frontend can resolve a citation back to its real url/sourceType.
  @IsOptional()
  @IsString()
  sourceId?: string;

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

  // Module 4 Phase 4.4 — FR-RES-001's own AC, literally: "Trend Agent
  // returns topic + opportunity score + freshness." Distinct from
  // `confidence` (how sure the model is about the direction) — this is
  // how actionable/valuable the trend is for content planning. Same
  // 0-100 scale as every other explainable score in this schema.
  @IsInt()
  @Min(0)
  @Max(100)
  opportunityScore!: number;

  // Topic novelty/age, not momentum (that's `direction`) — a
  // well-established topic can still be rising, and a brand-new one can
  // already be fading. Qualitative, not a fabricated precise timestamp:
  // the model has no real-time trend-tracking data to invent one from.
  @IsIn(["new", "ongoing", "long-standing"])
  freshness!: "new" | "ongoing" | "long-standing";
}

// FR-KW-002 (every keyword in a cluster gets an intent label — "Unknown"
// rather than dropped when unclassifiable) + FR-KW-003 (0-100,
// explainable score — rationale mandatory, never a black box).
export class KeywordClusterMember {
  @IsString()
  keyword!: string;

  @IsIn(["informational", "transactional", "navigational", "unknown"])
  intent!: "informational" | "transactional" | "navigational" | "unknown";

  @IsInt()
  @Min(0)
  @Max(100)
  opportunityScore!: number;

  @IsString()
  rationale!: string;
}

// Module 4 Phase 4.4 — FR-KW-001's own AC, literally: "Output includes
// primary + secondary keyword sets per cluster." Replaces Phase
// 4.1-4.3's flat KeywordOpportunity[] (which had per-keyword intent/
// score/rationale — satisfying FR-KW-002/003 — but no clustering
// structure at all, leaving FR-KW-001 itself, which FR-KW-002/003 both
// depend on, unmet).
export class KeywordCluster {
  @IsString()
  clusterTopic!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeywordClusterMember)
  primaryKeywords!: KeywordClusterMember[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeywordClusterMember)
  secondaryKeywords!: KeywordClusterMember[];
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

// Module 4 Phase 4.3 — FR-RES-002's own business rule, applied
// structurally: "Research must draw only from configured trusted
// sources." Populated only by postProcessOutput, never the model.
export class ResearchCitationIntegritySummary {
  @IsInt()
  @Min(0)
  invalidCitationsRemoved!: number;
}

export class ResearchAgentOutput {
  @IsString()
  executiveSummary!: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResearchFinding)
  findings!: ResearchFinding[];

  // Module 4 Phase 4.3 — no longer requested from the model at all
  // (@IsOptional, absent from the prompt's own response-shape
  // instruction below): postProcessOutput reconstructs this array
  // entirely from real, verified Knowledge-Pack source records for
  // every sourceId actually cited by a finding — never model-authored
  // url/title text, so there is nothing here for the model to fabricate.
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResearchSourceOutput)
  sources?: ResearchSourceOutput[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrendSignal)
  trendSignals!: TrendSignal[];

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeywordCluster)
  keywordClusters!: KeywordCluster[];

  @IsArray()
  @IsString({ each: true })
  contentAngles!: string[];

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchDeduplicationSummary)
  deduplication?: ResearchDeduplicationSummary;

  @IsOptional()
  @ValidateNested()
  @Type(() => ResearchCitationIntegritySummary)
  citationIntegrity?: ResearchCitationIntegritySummary;
}

function buildPrompt(input: ResearchAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const reachable = input.verifiedSources.filter((s) => s.reachable);
  const sourceList = reachable.length > 0 ? reachable.map((s) => `- [${s.sourceId}] [${s.sourceType}] ${s.url}`).join("\n") : "(none reachable — state this plainly in the executive summary, cite nothing)";

  // FR-KW-001's own Business Rule: "Uses the pack's configured keyword
  // sets as a seed, not as the only source" — distinct from
  // input.seedKeywords (ad hoc, per-request) below. AgentContext.keywords
  // is generically typed (Record<string, unknown>[]); the real shape
  // (from agent-context-builder.ts / the Worker's own context assembly)
  // is always { name: string; keywords: string[] }.
  const keywordSets = context.keywords as { name: string; keywords: string[] }[];
  const packKeywordSets = keywordSets.length > 0 ? keywordSets.map((k) => `- ${k.name}: ${k.keywords.join(", ")}`).join("\n") : "";

  const systemInstructions = [
    "You are the Research Agent for an EV (electric vehicle) content platform.",
    "You produce structured research intelligence: an executive summary, findings, trend signals, and keyword clusters.",
    "CRITICAL — citation integrity: findings[].sourceIds must contain ONLY the bracketed IDs (e.g. \"S1\") listed below under VERIFIED SOURCES — never a URL, never an ID you were not given, never one you invent. A citation referencing anything else will be discarded and that finding will be treated as your own unsupported inference, not evidence. If none are reachable, say so in executiveSummary and leave every finding's sourceIds empty.",
    "Do not output a sources[] field yourself — it is built automatically from the sources you actually cite by ID.",
    "CRITICAL — trend integrity: every trendSignals[] entry must name concrete evidence for its direction (from the sources or the given context) in its own evidence field. opportunityScore must reflect how actionable the trend is for content planning, not how confident you are in the direction. freshness describes the topic's own novelty (new/ongoing/long-standing), independent of direction. Never assert a trend has no basis beyond your own impression.",
    "CRITICAL — keyword integrity: group keywords into keywordClusters, each with a clusterTopic and its own primaryKeywords/secondaryKeywords lists — never a flat, unclustered list. Every keyword needs intent and an explainable opportunityScore (rationale is mandatory). Do not invent search volume, CPC, or competition metrics; you have no access to real search data in this context.",
    "",
    "VERIFIED SOURCES (cite ONLY by the bracketed ID):",
    sourceList,
    "",
    `WORKSPACE INDUSTRY PROFILE: ${JSON.stringify(context.industryProfile)}`,
    context.competitors.length > 0 ? `KNOWN COMPETITORS: ${context.competitors.map((c) => c.domain).join(", ")}` : "",
    packKeywordSets ? `KNOWLEDGE PACK'S CONFIGURED KEYWORD SETS (use as a seed, not your only source):\n${packKeywordSets}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Research topic: ${input.topic}`,
    input.objective ? `Objective: ${input.objective}` : "",
    input.geography ? `Geography: ${input.geography}` : "",
    input.language ? `Language: ${input.language}` : "",
    input.seedKeywords && input.seedKeywords.length > 0 ? `Additional ad hoc seed keywords to consider: ${input.seedKeywords.join(", ")}` : "",
    "",
    "Respond with a single JSON object matching the required ResearchAgentOutput schema exactly: executiveSummary, findings (each with summary, evidence, sourceIds), trendSignals (each with topic, direction, confidence, evidence, opportunityScore, freshness), keywordClusters (each with clusterTopic, primaryKeywords, secondaryKeywords), contentAngles.",
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

// Module 4 Phase 4.3 — FR-RES-002's own business rule ("Research must
// draw only from configured trusted sources") made structural rather
// than a prompt-only promise. For every finding, keeps only the
// sourceIds that match a REACHABLE entry in the request's own
// verifiedSources — anything else (a raw URL, a misremembered ID, an
// outright invention) is dropped, never "promoted" into a citation.
// sources[] is then reconstructed entirely from real Knowledge-Pack
// source records for whatever was actually cited, so nothing here is
// ever model-authored text.
function validateCitations(
  findings: ResearchFinding[],
  verifiedSources: VerifiedSourceInput[],
): { findings: ResearchFinding[]; sources: ResearchSourceOutput[]; invalidCitationsRemoved: number } {
  const byId = new Map(verifiedSources.filter((s) => s.reachable).map((s) => [s.sourceId, s]));

  let invalidCitationsRemoved = 0;
  const checkedFindings = findings.map((finding) => {
    const validIds = (finding.sourceIds ?? []).filter((id) => {
      const ok = byId.has(id);
      if (!ok) invalidCitationsRemoved += 1;
      return ok;
    });
    return { ...finding, sourceIds: validIds, provenance: (validIds.length > 0 ? "source_backed" : "ai_inference") as "source_backed" | "ai_inference" };
  });

  const citedIds = new Set(checkedFindings.flatMap((f) => f.sourceIds));
  const sources: ResearchSourceOutput[] = [...citedIds].map((id) => {
    const s = byId.get(id)!;
    return { sourceId: s.sourceId, url: s.url, sourceType: s.sourceType };
  });

  return { findings: checkedFindings, sources, invalidCitationsRemoved };
}

// FR-RES-004: "Duplicate detection runs before the research package is
// marked complete" — this runs as this agent's own postProcessOutput
// hook (packages/shared/src/agent-framework/agent-definition.ts), on the
// already schema-validated provider output, before the executor ever
// persists ai_jobs.output_payload or marks the job COMPLETED. Never an
// LLM step, so it is deterministic and reproducible for the same input.
// Citation validation runs first so dedup operates on an already-honest
// citation set, not on findings that might still reference bogus IDs.
function postProcessOutput(output: ResearchAgentOutput, input: ResearchAgentInput): ResearchAgentOutput {
  const { findings: citationCheckedFindings, sources: reconstructedSources, invalidCitationsRemoved } = validateCitations(output.findings, input.verifiedSources);

  try {
    const { deduped: findings, duplicatesRemoved: duplicateFindingsRemoved } = deduplicateFindings(citationCheckedFindings);
    const { deduped: sources, duplicatesRemoved: duplicateSourcesRemoved } = deduplicateSources(reconstructedSources);
    return {
      ...output,
      findings,
      sources,
      citationIntegrity: { invalidCitationsRemoved },
      deduplication: { duplicateFindingsRemoved, duplicateSourcesRemoved, requiresManualReview: false },
    };
  } catch {
    // FR-RES-004's own error condition, applied literally: a failure in
    // this deterministic pass must never fail an otherwise-successful
    // research job — the citation-checked-but-un-deduplicated output is
    // kept and flagged for manual review instead. Never surfaces the raw
    // internal error. Citation validation itself has already succeeded
    // by this point (it ran outside the try), so its own result is never
    // discarded even if dedup specifically fails.
    return {
      ...output,
      findings: citationCheckedFindings,
      sources: reconstructedSources,
      citationIntegrity: { invalidCitationsRemoved },
      deduplication: { duplicateFindingsRemoved: 0, duplicateSourcesRemoved: 0, requiresManualReview: true, reviewReason: "Automated deduplication could not be completed — findings and sources were not deduplicated." },
    };
  }
}

export const RESEARCH_AGENT_V1: AgentDefinition<ResearchAgentInput, ResearchAgentOutput> = {
  identifier: "research-agent",
  version: 1,
  purpose: "Produces structured research intelligence (findings, trend signals, keyword clusters) for a topic, grounded only in the workspace's own Knowledge-Pack-configured trusted sources — never fabricated citations.",
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
