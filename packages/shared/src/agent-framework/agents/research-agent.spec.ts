import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import type { AgentContext } from "../agent-context";
import { RESEARCH_AGENT_V1, ResearchAgentInput, ResearchAgentOutput } from "./research-agent";

function context(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    workspaceId: "ws_1",
    knowledgePackVersionId: "kp_1",
    industryProfile: { industry: "Electric Vehicles" },
    publishingStrategy: {},
    trustedSources: [],
    promptTemplates: [],
    seoRules: [],
    brandGuidelines: [],
    keywords: [],
    competitors: [],
    ...overrides,
  };
}

function input(overrides: Partial<ResearchAgentInput> = {}): ResearchAgentInput {
  return plainToInstance(ResearchAgentInput, {
    topic: "EV battery swap stations",
    verifiedSources: [],
    ...overrides,
  });
}

describe("RESEARCH_AGENT_V1", () => {
  it("registers under the expected identifier/version/provider", () => {
    expect(RESEARCH_AGENT_V1.identifier).toBe("research-agent");
    expect(RESEARCH_AGENT_V1.version).toBe(1);
    expect(RESEARCH_AGENT_V1.providerPreference.provider).toBe("openai");
  });

  // The timeoutMs-vs-manifest relationship (agent.timeoutMs STRICTLY
  // below AI_EXECUTE_V1_MANIFEST.timeout — never equal, see that file's
  // own doc comment) is enforced generically, for every registered
  // production agent including this one, in
  // agent-timeout-invariant.spec.ts — not duplicated here.

  it("lists only the exact reachable sources (by ID) in the system prompt's VERIFIED SOURCES section", () => {
    const req = input({
      verifiedSources: [
        { sourceId: "S1", url: "https://reachable.example/a", sourceType: "GOVERNMENT", reachable: true },
        { sourceId: "S2", url: "https://unreachable.example/b", sourceType: "NEWS", reachable: false },
      ],
    });
    const { systemInstructions } = RESEARCH_AGENT_V1.buildPrompt(req, context());
    expect(systemInstructions).toContain("[S1]");
    expect(systemInstructions).toContain("https://reachable.example/a");
    expect(systemInstructions).not.toContain("S2");
    expect(systemInstructions).not.toContain("https://unreachable.example/b");
  });

  it("states plainly that no sources are reachable rather than fabricating a placeholder ID", () => {
    const req = input({ verifiedSources: [{ sourceId: "S1", url: "https://unreachable.example/a", sourceType: "NEWS", reachable: false }] });
    const { systemInstructions } = RESEARCH_AGENT_V1.buildPrompt(req, context());
    expect(systemInstructions).toContain("none reachable");
    expect(systemInstructions).not.toContain("https://unreachable.example/a");
  });

  it("Module 4 Phase 4.4 (FR-KW-001): surfaces the Knowledge Pack's own configured keyword sets as a seed, distinct from ad hoc per-request seedKeywords", () => {
    const req = input({ seedKeywords: ["ad hoc keyword"] });
    const { systemInstructions } = RESEARCH_AGENT_V1.buildPrompt(req, context({ keywords: [{ name: "Core EV Terms", keywords: ["ev charging", "battery range"] }] }));
    expect(systemInstructions).toContain("Core EV Terms");
    expect(systemInstructions).toContain("ev charging");
    expect(systemInstructions).toContain("battery range");
  });

  it("rejects a trend signal missing FR-RES-001's own required opportunityScore/freshness fields", async () => {
    const instance = plainToInstance(ResearchAgentOutput, {
      executiveSummary: "ok",
      findings: [],
      trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 70, evidence: "x" }],
      keywordClusters: [],
      contentAngles: [],
    });
    const violations = await validate(instance);
    const trendViolations = violations.find((v) => v.property === "trendSignals")?.children?.[0]?.children ?? [];
    expect(trendViolations.some((v) => v.property === "opportunityScore")).toBe(true);
    expect(trendViolations.some((v) => v.property === "freshness")).toBe(true);
  });

  it("rejects a flat, unclustered keyword shape — FR-KW-001 requires clusters with primary/secondary sets", async () => {
    const instance = plainToInstance(ResearchAgentOutput, {
      executiveSummary: "ok",
      findings: [],
      trendSignals: [],
      keywordClusters: [{ clusterTopic: "EV battery swap" }],
      contentAngles: [],
    });
    const violations = await validate(instance);
    const clusterViolations = violations.find((v) => v.property === "keywordClusters")?.children?.[0]?.children ?? [];
    expect(clusterViolations.some((v) => v.property === "primaryKeywords")).toBe(true);
    expect(clusterViolations.some((v) => v.property === "secondaryKeywords")).toBe(true);
  });

  it("includes the topic and optional fields in the user prompt when provided", () => {
    const req = input({ objective: "find content gaps", geography: "India", seedKeywords: ["battery swap"] });
    const { prompt } = RESEARCH_AGENT_V1.buildPrompt(req, context());
    expect(prompt).toContain("EV battery swap stations");
    expect(prompt).toContain("find content gaps");
    expect(prompt).toContain("India");
    expect(prompt).toContain("battery swap");
  });

  it("rejects input missing the required topic field", async () => {
    const instance = plainToInstance(ResearchAgentInput, { verifiedSources: [] });
    const violations = await validate(instance);
    expect(violations.some((v) => v.property === "topic")).toBe(true);
  });

  it("rejects output missing required structured fields", async () => {
    const instance = plainToInstance(ResearchAgentOutput, { executiveSummary: "ok" });
    const violations = await validate(instance);
    expect(violations.some((v) => v.property === "findings")).toBe(true);
    expect(violations.some((v) => v.property === "trendSignals")).toBe(true);
  });

  it("accepts a fully valid structured output — sources[] is optional (the model no longer needs to supply it)", async () => {
    const instance = plainToInstance(ResearchAgentOutput, {
      executiveSummary: "EV battery swap stations are gaining traction.",
      findings: [{ summary: "Adoption is rising in dense urban areas.", sourceIds: ["S1"] }],
      trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 70, evidence: "Multiple government pilots referenced in source.", opportunityScore: 75, freshness: "ongoing" }],
      keywordClusters: [
        {
          clusterTopic: "EV battery swap",
          primaryKeywords: [{ keyword: "ev battery swap", intent: "informational", opportunityScore: 62, rationale: "High relevance to topic, no direct competitor coverage found in sources." }],
          secondaryKeywords: [],
        },
      ],
      contentAngles: ["A city-by-city look at battery swap rollouts"],
    });
    const violations = await validate(instance);
    expect(violations).toHaveLength(0);
  });
});

describe("RESEARCH_AGENT_V1.postProcessOutput", () => {
  const verifiedSources = [
    { sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT", reachable: true },
    { sourceId: "S2", url: "https://reachable.example/pub", sourceType: "PUBLICATION", reachable: true },
    { sourceId: "S3", url: "https://unreachable.example/news", sourceType: "PUBLICATION", reachable: false },
  ];

  function output(overrides: Partial<ResearchAgentOutput> = {}): ResearchAgentOutput {
    return plainToInstance(ResearchAgentOutput, {
      executiveSummary: "EV battery swap stations are gaining traction.",
      findings: [],
      trendSignals: [],
      keywordClusters: [],
      contentAngles: [],
      ...overrides,
    });
  }

  function run(out: ResearchAgentOutput, sources = verifiedSources): ResearchAgentOutput {
    return RESEARCH_AGENT_V1.postProcessOutput!(out, input({ verifiedSources: sources }));
  }

  describe("FR-RES-002 structural citation integrity", () => {
    it("accepts a finding citing a valid, reachable source ID — provenance is source_backed", () => {
      const result = run(output({ findings: [{ summary: "Multiple pilots are underway.", sourceIds: ["S1"] }] }));
      expect(result.findings[0].sourceIds).toEqual(["S1"]);
      expect(result.findings[0].provenance).toBe("source_backed");
      expect(result.citationIntegrity).toEqual({ invalidCitationsRemoved: 0 });
    });

    it("rejects an unknown source ID — never promotes it into a verified citation, provenance falls back to ai_inference", () => {
      const result = run(output({ findings: [{ summary: "A claim with an invented citation.", sourceIds: ["S99"] }] }));
      expect(result.findings[0].sourceIds).toEqual([]);
      expect(result.findings[0].provenance).toBe("ai_inference");
      expect(result.citationIntegrity).toEqual({ invalidCitationsRemoved: 1 });
    });

    it("never promotes an arbitrary model-written URL into sources[] — only real source IDs resolve", () => {
      const result = run(output({ findings: [{ summary: "A claim citing a raw URL instead of an ID.", sourceIds: ["https://fabricated-not-in-request.example"] }] }));
      expect(result.findings[0].sourceIds).toEqual([]);
      expect(result.sources).toEqual([]);
    });

    it("rejects a source ID belonging to a source that was unreachable at submission time", () => {
      const result = run(output({ findings: [{ summary: "Cites the unreachable source.", sourceIds: ["S3"] }] }));
      expect(result.findings[0].sourceIds).toEqual([]);
      expect(result.findings[0].provenance).toBe("ai_inference");
      expect(result.citationIntegrity?.invalidCitationsRemoved).toBe(1);
    });

    it("reconstructs sources[] entirely from real verified-source data for every ID actually cited — never model-authored url/title text", () => {
      const result = run(
        output({
          findings: [{ summary: "Cites a real source.", sourceIds: ["S1"] }],
        }),
      );
      expect(result.sources).toEqual([{ sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT" }]);
    });

    it("deduplicates the reconstructed sources[] when the same ID is cited by multiple findings", () => {
      const result = run(
        output({
          findings: [
            { summary: "First finding citing S1.", sourceIds: ["S1"] },
            { summary: "Second, unrelated finding also citing S1.", sourceIds: ["S1"] },
          ],
        }),
      );
      expect(result.sources).toHaveLength(1);
    });

    it("is deterministic — the same output+input produces the same citation result across repeated calls (retry/redelivery stability)", () => {
      const raw = output({ findings: [{ summary: "Cites a real source.", sourceIds: ["S1", "S99"] }] });
      const first = run(raw);
      const second = run(raw);
      expect(first.findings).toEqual(second.findings);
      expect(first.sources).toEqual(second.sources);
      expect(first.citationIntegrity).toEqual(second.citationIntegrity);
    });
  });

  describe("FR-RES-004 deduplication", () => {
    it("removes near-duplicate findings and counts them, keeping genuinely distinct findings", () => {
      const result = run(
        output({
          findings: [
            { summary: "EV battery swap adoption is rising fast in dense urban areas across India.", sourceIds: [] },
            { summary: "EV battery swap adoption is rising quickly in dense urban areas across India.", sourceIds: [] },
            { summary: "Charging infrastructure investment has doubled in rural highway corridors.", sourceIds: [] },
          ],
        }),
      );
      expect(result.findings).toHaveLength(2);
      expect(result.findings.map((f) => f.summary)).toContain("Charging infrastructure investment has doubled in rural highway corridors.");
      expect(result.deduplication).toEqual({ duplicateFindingsRemoved: 1, duplicateSourcesRemoved: 0, requiresManualReview: false });
    });

    it("preserves findings that are merely topically related but not near-duplicates", () => {
      const result = run(
        output({
          findings: [
            { summary: "Battery swap stations reduce charging downtime for fleet operators.", sourceIds: [] },
            { summary: "Government subsidies target two-wheeler battery swap networks specifically.", sourceIds: [] },
          ],
        }),
      );
      expect(result.findings).toHaveLength(2);
      expect(result.deduplication?.duplicateFindingsRemoved).toBe(0);
    });

    it("flags for manual review instead of throwing when the dedup pass itself fails, and never blocks the job", () => {
      // A finding with a non-string summary (bypassing TypeScript, as a
      // real internal failure mode would) crashes deduplicateFindings's
      // own text-comparison logic specifically — validateCitations never
      // touches .summary, so citation validation still succeeds and its
      // result is preserved even though dedup fails. Proves FR-RES-004's
      // own error condition: "deduplication failure does not block the
      // job," and that the two integrity passes fail independently.
      const malformed = output({
        findings: [
          { summary: "Cites a real source.", sourceIds: ["S1"] },
          { summary: "A second finding.", sourceIds: ["S1"] },
        ],
      });
      // .some()'s callback only runs once `kept` is non-empty (i.e. from
      // the second finding onward) — a single malformed finding alone
      // would never actually reach the comparison and wouldn't prove
      // anything.
      (malformed.findings[1] as unknown as { summary: unknown }).summary = null;

      expect(() => run(malformed)).not.toThrow();
      const result = run(malformed);
      expect(result.deduplication?.requiresManualReview).toBe(true);
      expect(result.deduplication?.reviewReason).toBeTruthy();
      expect(result.deduplication?.reviewReason).not.toContain("TypeError");
      // Citation validation ran before the try/catch, so its own correct
      // result is preserved even though dedup failed.
      expect(result.citationIntegrity).toEqual({ invalidCitationsRemoved: 0 });
      expect(result.executiveSummary).toBe("EV battery swap stations are gaining traction.");
    });

    it("produces output that still validates as a full ResearchAgentOutput after post-processing", async () => {
      const result = run(output({ findings: [{ summary: "Adoption is rising in dense urban areas.", sourceIds: ["S1"] }] }));
      const instance = plainToInstance(ResearchAgentOutput, result);
      const violations = await validate(instance);
      expect(violations).toHaveLength(0);
    });
  });
});
