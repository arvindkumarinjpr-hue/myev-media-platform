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

  it("declares a timeoutMs under the durable ai.execute.v1 manifest's own 30s hard ceiling", () => {
    // A regression proof for the real bug this phase found: an agent
    // timeoutMs above the manifest's own enforced `timeout` would have
    // every durable execution killed by BullMqWorkerManager's own
    // Promise.race before this AbortController ever fires.
    expect(RESEARCH_AGENT_V1.timeoutMs).toBeLessThan(30_000);
  });

  it("lists only the exact reachable URLs in the system prompt's VERIFIED SOURCES section", () => {
    const req = input({
      verifiedSources: [
        { url: "https://reachable.example/a", sourceType: "GOVERNMENT", reachable: true },
        { url: "https://unreachable.example/b", sourceType: "NEWS", reachable: false },
      ],
    });
    const { systemInstructions } = RESEARCH_AGENT_V1.buildPrompt(req, context());
    expect(systemInstructions).toContain("https://reachable.example/a");
    expect(systemInstructions).not.toContain("https://unreachable.example/b");
  });

  it("states plainly that no sources are reachable rather than fabricating a placeholder URL", () => {
    const req = input({ verifiedSources: [{ url: "https://unreachable.example/a", sourceType: "NEWS", reachable: false }] });
    const { systemInstructions } = RESEARCH_AGENT_V1.buildPrompt(req, context());
    expect(systemInstructions).toContain("none reachable");
    expect(systemInstructions).not.toContain("https://unreachable.example/a");
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

  it("accepts a fully valid structured output", async () => {
    const instance = plainToInstance(ResearchAgentOutput, {
      executiveSummary: "EV battery swap stations are gaining traction.",
      findings: [{ summary: "Adoption is rising in dense urban areas.", sourceUrls: ["https://reachable.example/a"] }],
      sources: [{ url: "https://reachable.example/a", sourceType: "GOVERNMENT" }],
      trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 70, evidence: "Multiple government pilots referenced in source." }],
      keywordOpportunities: [{ keyword: "ev battery swap", intent: "informational", opportunityScore: 62, rationale: "High relevance to topic, no direct competitor coverage found in sources." }],
      contentAngles: ["A city-by-city look at battery swap rollouts"],
    });
    const violations = await validate(instance);
    expect(violations).toHaveLength(0);
  });
});
