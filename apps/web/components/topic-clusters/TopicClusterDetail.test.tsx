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

  it("renders a large keyword set with long phrases and no Content Series without exposing any internal ID", async () => {
    const longPhrase = "what happens if my ev battery swap subscription renews while I am travelling internationally";
    const many = Array.from({ length: 12 }, (_, i) => ({
      term: i === 0 ? longPhrase : `battery swap keyword variant number ${i}`,
      searchIntent: "INFORMATIONAL",
      opportunityScore: 40 + i,
      rationale: `Rationale for variant ${i}.`,
    }));
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: {
          publicId: "tc-2",
          name: "Battery swap FAQ cluster",
          clusterTopic: "Battery swap FAQ cluster",
          primaryKeywords: many,
          secondaryKeywords: [],
          sourceResearchId: "res-9",
          knowledgePackVersionId: "kp-9",
          contentSeries: null,
          createdAt: "2026-02-01T00:00:00.000Z",
        },
      }),
    );
    render(<TopicClusterDetail workspaceId="ws-1" topicClusterId="tc-2" />);

    await waitFor(() => expect(screen.getByText(longPhrase)).toBeInTheDocument());
    expect(screen.getByText("battery swap keyword variant number 11")).toBeInTheDocument();
    // No Content Series on this cluster — "Content Series" is omitted
    // entirely rather than shown as a blank/dash field.
    expect(screen.queryByText("Content Series")).not.toBeInTheDocument();
    // Never the raw Knowledge Pack version id or Research run id as
    // visible text — only the "this Research run" link label.
    expect(screen.queryByText("kp-9")).not.toBeInTheDocument();
    expect(screen.queryByText("res-9")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "this Research run" })).toHaveAttribute("href", "/workspaces/ws-1/research/res-9");
  });
});
