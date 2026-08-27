import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateTopicClusterForm } from "./CreateTopicClusterForm";
import { mockResponse } from "../../lib/test-mock-response";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

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
    keywordClusters: [{ clusterTopic: "EV battery swap", primaryKeywords: [{ keyword: "ev battery swap", intent: "informational", opportunityScore: 70, rationale: "x" }], secondaryKeywords: [] }],
    contentAngles: [],
  },
};

describe("CreateTopicClusterForm", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("submits a research run + keyword cluster and navigates to the topic cluster detail page", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse({ data: [COMPLETED_RESEARCH] }))
      .mockResolvedValueOnce(mockResponse({ data: [] }))
      .mockResolvedValueOnce(mockResponse({ data: { publicId: "tc-new" } }, 201));

    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByLabelText("Research run")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Research run"), "res-1");
    await userEvent.selectOptions(screen.getByLabelText("Keyword cluster"), "EV battery swap");
    await userEvent.click(screen.getByRole("button", { name: "Create Topic Cluster" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/topic-clusters/tc-new"));
  });

  it("shows a message instead of the form when there is no completed Research with a keyword cluster", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText(/need a completed Research run/i)).toBeInTheDocument());
    expect(screen.queryByLabelText("Research run")).not.toBeInTheDocument();
  });

  it("disables submit until both a research run and a keyword cluster are selected", async () => {
    jest.spyOn(global, "fetch").mockResolvedValueOnce(mockResponse({ data: [COMPLETED_RESEARCH] })).mockResolvedValueOnce(mockResponse({ data: [] }));
    render(<CreateTopicClusterForm workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Create Topic Cluster" })).toBeDisabled());
    await userEvent.selectOptions(screen.getByLabelText("Research run"), "res-1");
    expect(screen.getByRole("button", { name: "Create Topic Cluster" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Keyword cluster"), "EV battery swap");
    expect(screen.getByRole("button", { name: "Create Topic Cluster" })).toBeEnabled();
  });
});
