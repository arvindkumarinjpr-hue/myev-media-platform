import { render, screen, waitFor } from "@testing-library/react";
import { ResearchDetail } from "./ResearchDetail";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { Research, WorkspaceDetail } from "../../lib/types";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const workspace = {
  publicId: "ws-1",
  name: "Demo",
  slug: "demo",
  status: "ACTIVE",
  settings: {},
  featureFlags: {},
  myRole: "Owner",
} satisfies WorkspaceDetail;

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

function renderDetail(permissions: string[] = ["RESEARCH_VIEW", "TOPIC_CLUSTER_MANAGE"]) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <ResearchDetail workspaceId="ws-1" researchId="res-1" />
    </SessionProvider>,
  );
}

describe("ResearchDetail", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shows a pending message while QUEUED", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: research({ status: "QUEUED", completedAt: null, startedAt: null }) }));
    renderDetail();

    await waitFor(() => expect(screen.getByText("Queued")).toBeInTheDocument());
    expect(screen.getByText(/will update automatically/i)).toBeInTheDocument();
    expect(screen.getByText("Research is in progress")).toBeInTheDocument();
  });

  it("renders every section of a completed result — never mixing raw provider payloads into the display", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [{ summary: "Multiple pilots underway.", evidence: "Cited government source.", sourceIds: ["S1"], provenance: "source_backed" }],
        sources: [{ sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT", title: "EV Infra Report" }],
        trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 70, evidence: "Pilot count increasing.", opportunityScore: 80, freshness: "ongoing" }],
        keywordClusters: [
          {
            clusterTopic: "EV battery swap",
            primaryKeywords: [{ keyword: "ev battery swap", intent: "informational", opportunityScore: 62, rationale: "High relevance, low competitor coverage." }],
            secondaryKeywords: [],
          },
        ],
        contentAngles: ["A city-by-city rollout comparison"],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    renderDetail();

    await waitFor(() => expect(screen.getByText("Battery swap pilots are expanding.")).toBeInTheDocument());
    expect(screen.getByText("Multiple pilots underway.")).toBeInTheDocument();
    // The source title appears both as the resolved citation and in the Sources list.
    expect(screen.getAllByText("EV Infra Report").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("battery swap")).toBeInTheDocument();
    expect(screen.getByText("ev battery swap")).toBeInTheDocument();
    expect(screen.getByText("A city-by-city rollout comparison")).toBeInTheDocument();
    expect(screen.getByText("Executive summary")).toBeInTheDocument();
  });

  it("labels a source-backed finding distinctly from an AI-inference finding, and resolves a citation ID to a real link", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [
          { summary: "A cited, source-backed claim.", sourceIds: ["S1"], provenance: "source_backed" },
          { summary: "The model's own unsupported inference.", sourceIds: [], provenance: "ai_inference" },
        ],
        sources: [{ sourceId: "S1", url: "https://reachable.example/gov", sourceType: "GOVERNMENT" }],
        trendSignals: [],
        keywordClusters: [],
        contentAngles: [],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    renderDetail();

    await waitFor(() => expect(screen.getByText("Source-backed")).toBeInTheDocument());
    expect(screen.getByText("AI inference")).toBeInTheDocument();
    // The citation resolves to a real outbound link (finding + Sources list),
    // labelled by the source's readable hostname, never "S1".
    const links = screen.getAllByRole("link", { name: /reachable\.example/ });
    expect(links.length).toBeGreaterThanOrEqual(2);
    links.forEach((link) => expect(link).toHaveAttribute("href", "https://reachable.example/gov"));
    expect(screen.queryByText("S1")).not.toBeInTheDocument();
  });

  it("renders trend opportunity/freshness and keyword clusters grouped into primary/secondary sets", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [],
        sources: [],
        trendSignals: [{ topic: "battery swap", direction: "rising", confidence: 70, evidence: "x", opportunityScore: 82, freshness: "new" }],
        keywordClusters: [
          {
            clusterTopic: "EV battery swap",
            primaryKeywords: [{ keyword: "ev battery swap station", intent: "informational", opportunityScore: 71, rationale: "High relevance." }],
            secondaryKeywords: [{ keyword: "battery swap cost", intent: "transactional", opportunityScore: 43, rationale: "Lower but real relevance." }],
          },
        ],
        contentAngles: [],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    renderDetail();

    await waitFor(() => expect(screen.getByText("EV battery swap")).toBeInTheDocument());
    expect(screen.getByText("Rising")).toBeInTheDocument();
    expect(screen.getByText("New")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(screen.getByText("Secondary")).toBeInTheDocument();
    expect(screen.getByText("ev battery swap station")).toBeInTheDocument();
    expect(screen.getByText("battery swap cost")).toBeInTheDocument();
  });

  it("shows the Create Topic Cluster CTA only for a completed run with clusters and the right permission", async () => {
    const withClusters = research({
      result: {
        executiveSummary: "x",
        findings: [],
        sources: [],
        trendSignals: [],
        keywordClusters: [{ clusterTopic: "EV battery swap", primaryKeywords: [], secondaryKeywords: [] }],
        contentAngles: [],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: withClusters }));
    renderDetail(["RESEARCH_VIEW", "TOPIC_CLUSTER_MANAGE"]);

    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Create Topic Cluster/ })).toHaveAttribute(
        "href",
        "/workspaces/ws-1/topic-clusters/new?research=res-1",
      ),
    );
  });

  it("hides the Create Topic Cluster CTA without TOPIC_CLUSTER_MANAGE", async () => {
    const withClusters = research({
      result: {
        executiveSummary: "x",
        findings: [],
        sources: [],
        trendSignals: [],
        keywordClusters: [{ clusterTopic: "EV battery swap", primaryKeywords: [], secondaryKeywords: [] }],
        contentAngles: [],
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: withClusters }));
    renderDetail(["RESEARCH_VIEW"]);

    await waitFor(() => expect(screen.getByText("Executive summary")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Create Topic Cluster/ })).not.toBeInTheDocument();
  });

  it("shows a duplicate-removed note when FR-RES-004 deduplication removed something", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [],
        sources: [{ url: "https://reachable.example/gov", sourceType: "GOVERNMENT", title: "EV Infra Report" }],
        trendSignals: [],
        keywordClusters: [],
        contentAngles: [],
        deduplication: { duplicateFindingsRemoved: 2, duplicateSourcesRemoved: 1, requiresManualReview: false },
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    renderDetail();

    await waitFor(() => expect(screen.getByText(/2 duplicate finding\(s\) and 1 duplicate source\(s\)/)).toBeInTheDocument());
  });

  it("shows a manual-review warning, not a duplicate-removed note, when the dedup pass itself failed", async () => {
    const completed = research({
      result: {
        executiveSummary: "Battery swap pilots are expanding.",
        findings: [],
        sources: [],
        trendSignals: [],
        keywordClusters: [],
        contentAngles: [],
        deduplication: { duplicateFindingsRemoved: 0, duplicateSourcesRemoved: 0, requiresManualReview: true },
      },
    });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: completed }));
    renderDetail();

    await waitFor(() => expect(screen.getByText(/could not be completed for this research/i)).toBeInTheDocument());
    expect(screen.queryByText(/duplicate finding\(s\)/)).not.toBeInTheDocument();
  });

  it("shows only the safe failure explanation for a failed run — never a raw provider payload", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({ data: research({ status: "FAILED", result: null, errorCode: "PROVIDER_ERROR", errorMessageSafe: "The AI provider was temporarily unavailable." }) }),
    );
    renderDetail();

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("The AI provider was temporarily unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start new Research" })).toBeInTheDocument();
  });

  it("uses a friendly explanation for PROVIDER_NOT_CONFIGURED", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({ data: research({ status: "FAILED", result: null, errorCode: "PROVIDER_NOT_CONFIGURED", errorMessageSafe: "provider registry: no adapter" }) }),
    );
    renderDetail();

    await waitFor(() => expect(screen.getByText(/AI provider required for this Research run isn't configured/i)).toBeInTheDocument());
    expect(screen.queryByText(/provider registry/i)).not.toBeInTheDocument();
  });
});
