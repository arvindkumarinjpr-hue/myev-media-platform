import { render, screen, waitFor } from "@testing-library/react";
import { TopicClusterDetail } from "./TopicClusterDetail";
import { mockResponse } from "../../lib/test-mock-response";

describe("TopicClusterDetail", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders the keyword breakdown and provenance link — never a raw JSON blob", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: {
          publicId: "tc-1",
          name: "EV battery swap",
          clusterTopic: "EV battery swap",
          primaryKeywords: [{ term: "ev battery swap station", searchIntent: "INFORMATIONAL", opportunityScore: 70, rationale: "High relevance." }],
          secondaryKeywords: [{ term: "battery swap cost", searchIntent: "TRANSACTIONAL", opportunityScore: 40, rationale: "Lower relevance." }],
          sourceResearchId: "res-1",
          knowledgePackVersionId: "kp-1",
          contentSeries: { publicId: "series-1", name: "Battery Swap Series" },
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    );
    render(<TopicClusterDetail workspaceId="ws-1" topicClusterId="tc-1" />);

    await waitFor(() => expect(screen.getByRole("heading", { name: "EV battery swap" })).toBeInTheDocument());
    expect(screen.getByText("ev battery swap station")).toBeInTheDocument();
    expect(screen.getByText("battery swap cost")).toBeInTheDocument();
    expect(screen.getByText("Battery Swap Series")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "this Research run" })).toHaveAttribute("href", "/workspaces/ws-1/research/res-1");
  });

  it("shows only the safe error message on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "TOPIC_CLUSTER_NOT_FOUND", message: "Topic cluster not found." }, 404));
    render(<TopicClusterDetail workspaceId="ws-1" topicClusterId="missing" />);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Topic cluster not found.")).toBeInTheDocument();
  });
});
