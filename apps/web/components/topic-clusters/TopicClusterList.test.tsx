import { render, screen, waitFor } from "@testing-library/react";
import { TopicClusterList } from "./TopicClusterList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <TopicClusterList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

const SAMPLE_CLUSTER = {
  publicId: "tc-1",
  name: "EV battery swap",
  clusterTopic: "EV battery swap",
  primaryKeywords: [{ term: "ev battery swap station", searchIntent: "INFORMATIONAL", opportunityScore: 70, rationale: "x" }],
  secondaryKeywords: [],
  sourceResearchId: "res-1",
  knowledgePackVersionId: "kp-1",
  contentSeries: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("TopicClusterList", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows a loading state, then renders the list once data arrives", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [SAMPLE_CLUSTER] }));
    renderWithSession(["TOPIC_CLUSTER_MANAGE"]);

    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("EV battery swap")).toBeInTheDocument());
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("shows an empty state with a create action when the user can manage topic clusters", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["TOPIC_CLUSTER_MANAGE"]);

    await waitFor(() => expect(screen.getByText("No topic clusters yet")).toBeInTheDocument());
    expect(screen.getByText("Create the first one")).toBeInTheDocument();
  });

  it("hides the create action for a user without TOPIC_CLUSTER_MANAGE", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession([]);

    await waitFor(() => expect(screen.getByText("No topic clusters yet")).toBeInTheDocument());
    expect(screen.queryByText("Create Topic Cluster")).not.toBeInTheDocument();
    expect(screen.queryByText("Create the first one")).not.toBeInTheDocument();
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["TOPIC_CLUSTER_MANAGE"]);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
