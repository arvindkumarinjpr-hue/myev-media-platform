import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateTopicClusterForm } from "./CreateTopicClusterForm";
import { mockResponse } from "../../lib/test-mock-response";

const push = jest.fn();
let searchParams = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

const COMPLETED_RESEARCH = {
  publicId: "res-1",
  topic: "EV battery swap stations",
  status: "COMPLETED",
  knowledgePackVersionId: "kp-1",
  agentVersion: 1,
  providerUsed: "openai",
  modelUsed: "gpt-4o",
  tokenUsage: null,
  generationSettings: null,
  errorCode: null,
  errorMessageSafe: null,
  correlationId: "corr-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  startedAt: "2026-01-01T00:00:01.000Z",
  completedAt: "2026-01-01T00:00:05.000Z",
  result: {
    executiveSummary: "x",
    findings: [],
    sources: [],
    trendSignals: [],
    keywordClusters: [
      {
        clusterTopic: "EV battery swap",
        primaryKeywords: [{ keyword: "ev battery swap", intent: "informational", opportunityScore: 70, rationale: "x" }],
        secondaryKeywords: [],
      },
    ],
    contentAngles: [],
  },
};

function mockBackend(research: unknown[]) {
  jest.spyOn(global, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.includes("/research")) return Promise.resolve(mockResponse({ data: research }));
    if (url.includes("/content-series")) return Promise.resolve(mockResponse({ data: [] }));
    if (url.includes("/knowledge-packs")) return Promise.resolve(mockResponse({ data: [{ publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 1 }] }));
    if (url.includes("/topic-clusters")) return Promise.resolve(mockResponse({ data: { publicId: "tc-new" } }, 201));
    return Promise.resolve(mockResponse({ data: [] }));
  });
}

describe("CreateTopicClusterForm", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("");
    (global.fetch as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("walks the stepper — research → cluster → series → review — then creates and navigates", async () => {
    mockBackend([COMPLETED_RESEARCH]);
    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    // Step 1: pick a Research run.
    await screen.findByText("Select a Research run");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /EV battery swap stations/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    // Step 2: pick a keyword cluster.
    await screen.findByText("Select a keyword cluster");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await userEvent.click(screen.getByRole("radio", { name: /EV battery swap/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    // Step 3: content series — "No series" is preselected.
    await screen.findByText("Attach to a Content Series");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    // Step 4: review + create.
    await screen.findByText("Review and create");
    expect(screen.getByText("EV battery swap stations")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create Topic Cluster" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/topic-clusters/tc-new"));
  });

  it("preselects the Research run from ?research= and starts on the cluster step", async () => {
    searchParams = new URLSearchParams("research=res-1");
    mockBackend([COMPLETED_RESEARCH]);
    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    await screen.findByText("Select a keyword cluster");
  });

  it("shows a message instead of the stepper when there is no usable completed Research", async () => {
    mockBackend([]);
    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText(/need a completed Research run/i)).toBeInTheDocument());
    expect(screen.queryByText("Select a Research run")).not.toBeInTheDocument();
  });

  it("submits the chosen content series id when one is selected", async () => {
    jest.spyOn(global, "fetch").mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/research")) return Promise.resolve(mockResponse({ data: [COMPLETED_RESEARCH] }));
      if (url.includes("/content-series")) return Promise.resolve(mockResponse({ data: [{ publicId: "series-9", projectId: null, name: "Charging 101", createdAt: "", updatedAt: "" }] }));
      if (url.includes("/knowledge-packs")) return Promise.resolve(mockResponse({ data: [] }));
      return Promise.resolve(mockResponse({ data: { publicId: "tc-new" } }, 201));
    });
    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    await screen.findByText("Select a Research run");
    await userEvent.click(screen.getByRole("radio", { name: /EV battery swap stations/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("radio", { name: /EV battery swap/ }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("radio", { name: "Charging 101" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Create Topic Cluster" }));

    await waitFor(() => expect(push).toHaveBeenCalled());
    const createCall = (global.fetch as jest.Mock).mock.calls.find(
      (c) => String(c[0]).endsWith("/topic-clusters") && (c[1] as RequestInit)?.method === "POST",
    );
    expect(JSON.parse((createCall![1] as RequestInit).body as string)).toMatchObject({
      researchId: "res-1",
      keywordClusterTopic: "EV battery swap",
      contentSeriesId: "series-9",
    });
  });
});
