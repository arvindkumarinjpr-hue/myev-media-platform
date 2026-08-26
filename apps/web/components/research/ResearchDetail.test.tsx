import { render, screen, waitFor } from "@testing-library/react";
import { ResearchDetail } from "./ResearchDetail";
import { mockResponse } from "../../lib/test-mock-response";
import type { Research } from "../../lib/types";

function research(overrides: Partial<Research> = {}): Research {
  return {
    publicId: "res-1",
    topic: "EV battery swap stations",
    status: "COMPLETED",
    knowledgePackVersionId: "kp-1",
    agentVersion: 1,
    providerUsed: "openai",
    modelUsed: "gpt-4o",
    tokenUsage: null,
    generationSettings: null,
    result: null,
    errorCode: null,
    errorMessageSafe: null,
    correlationId: "corr-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:01.000Z",
    completedAt: "2026-01-01T00:00:05.000Z",
    ...overrides,
  };
}

describe("ResearchDetail", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows a pending message while QUEUED", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: research({ status: "QUEUED", completedAt: null, startedAt: null }) }));
    render(<ResearchDetail workspaceId="ws-1" researchId="res-1" />);

    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
    expect(screen.getByText(/will update automatically/i)).toBeInTheDocument();
  });

  it("renders every section of a completed result — never mixing raw provider payloads into the display", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [{ summary: "Multiple pilots underway.", evidence: "Cited government source.", sourceIds: ["S1"], provenance: "source_backed" }],
        sources: [{ sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT", title: "EV Infra Report" }],
        trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 70, evidence: "Pilot count increasing." }],
        keywordOpportunities: [{ keyword: "ev battery swap", intent: "informational", opportunityScore: 62, rationale: "High relevance, low competitor coverage." }],
        contentAngles: ["A city-by-city rollout comparison"],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    render(<ResearchDetail workspaceId="ws-1" researchId="res-1" />);

    await waitFor(() => expect(screen.getByText("Battery swap pilots are expanding.")).toBeInTheDocument());
    expect(screen.getByText("Multiple pilots underway.")).toBeInTheDocument();
    expect(screen.getByText("EV Infra Report")).toBeInTheDocument();
    expect(screen.getByText("battery swap")).toBeInTheDocument();
    expect(screen.getByText("ev battery swap")).toBeInTheDocument();
    expect(screen.getByText("A city-by-city rollout comparison")).toBeInTheDocument();
  });

  it("labels a source-backed finding distinctly from an AI-inference finding, and resolves a citation ID to its real URL", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [
          { summary: "A cited, source-backed claim.", sourceIds: ["S1"], provenance: "source_backed" },
          { summary: "The model's own unsupported inference.", sourceIds: [], provenance: "ai_inference" },
        ],
        sources: [{ sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT" }],
        trendSignals: [],
        keywordOpportunities: [],
        contentAngles: [],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    render(<ResearchDetail workspaceId="ws-1" researchId="res-1" />);

    await waitFor(() => expect(screen.getByText("Source-backed")).toBeInTheDocument());
    expect(screen.getByText("AI inference")).toBeInTheDocument();
    // Appears twice: the resolved citation link inside the finding, and
    // again in the Sources & Evidence section — both real, both correct.
    expect(screen.getAllByRole("link", { name: "https://reachable.example/gov" })).toHaveLength(2);
  });

  it("shows a duplicate-removed note when FR-RES-004 deduplication removed something", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [{ summary: "Multiple pilots underway.", evidence: "Cited government source.", sourceIds: ["S1"], provenance: "source_backed" }],
        sources: [{ sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT", title: "EV Infra Report" }],
        trendSignals: [],
        keywordOpportunities: [],
        contentAngles: [],
        deduplication: { duplicateFindingsRemoved: 2, duplicateSourcesRemoved: 1, requiresManualReview: false },
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    render(<ResearchDetail workspaceId="ws-1" researchId="res-1" />);

    await waitFor(() => expect(screen.getByText(/2 duplicate finding\(s\) and 1 duplicate source\(s\)/)).toBeInTheDocument());
  });

  it("shows a manual-review warning, not a duplicate-removed note, when the dedup pass itself failed", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [],
        sources: [],
        trendSignals: [],
        keywordOpportunities: [],
        contentAngles: [],
        deduplication: { duplicateFindingsRemoved: 0, duplicateSourcesRemoved: 0, requiresManualReview: true, reviewReason: "Automated deduplication could not be completed." },
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    render(<ResearchDetail workspaceId="ws-1" researchId="res-1" />);

    await waitFor(() => expect(screen.getByText(/could not be completed for this research/i)).toBeInTheDocument());
    expect(screen.queryByText(/duplicate finding\(s\)/)).not.toBeInTheDocument();
  });

  it("shows only the safe error message for a failed research — never a raw provider payload", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({ data: research({ status: "FAILED", result: null, errorCode: "PROVIDER_ERROR", errorMessageSafe: "The AI provider was temporarily unavailable." }) }),
    );
    render(<ResearchDetail workspaceId="ws-1" researchId="res-1" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("The AI provider was temporarily unavailable.")).toBeInTheDocument();
  });
});
