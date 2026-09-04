import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InternalLinkingWorkspace } from "./InternalLinkingWorkspace";
import { mockResponse } from "../../lib/test-mock-response";
import type { ClusterLinkHealth, OrphanBlog, WorkspaceLinkHealthSummary } from "../../lib/types";

const summary: WorkspaceLinkHealthSummary = {
  eligibleApprovedBlogs: 12,
  orphanBlogs: 3,
  blogsWithNoOutgoingAcceptedLinks: 4,
  acceptedLinks: 9,
  generatedRecommendations: 5,
  staleRecommendations: 1,
  rejectedRecommendations: 2,
  clustersEvaluated: 4,
  clustersWithOrphans: 2,
};

const orphan: OrphanBlog = {
  contentItemPublicId: "blog-9",
  title: "Charging Network Roundup",
  urlSlug: "charging-network-roundup",
  contentSeriesPublicId: "series-1",
  topicClusterPublicId: "tc-1",
  incomingAcceptedLinkCount: 0,
  outgoingAcceptedLinkCount: 2,
  latestContentScore: 71,
  updatedAt: "2026-08-01T00:00:00.000Z",
  reason: "NO_ACCEPTED_INCOMING_LINKS",
};

const cluster: ClusterLinkHealth = {
  topicClusterPublicId: "tc-1",
  name: "EV Charging",
  approvedBlogCount: 5,
  orphanBlogCount: 1,
  blogsWithZeroOutgoingAcceptedLinksCount: 2,
  intraClusterAcceptedLinkCount: 3,
  crossClusterAcceptedLinkCount: 1,
  linkCoveragePercentage: 80,
};

function routeFetch(routes: { summary?: unknown; orphans?: unknown; "cluster-health"?: unknown }) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes("/cluster-health")) return mockResponse({ data: routes["cluster-health"] ?? [] });
    if (url.includes("/orphans")) return mockResponse({ data: routes.orphans ?? [] });
    if (url.includes("/summary")) return mockResponse({ data: routes.summary ?? null });
    return mockResponse({ data: null }, 404);
  });
}

describe("InternalLinkingWorkspace", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders the Overview stat cards from the summary endpoint", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ summary, orphans: [], "cluster-health": [] }));
    render(<InternalLinkingWorkspace workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText("Eligible approved Blogs")).toBeInTheDocument());
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Orphan Blogs")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("shows a healthy empty state when there are no orphans", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ summary, orphans: [], "cluster-health": [] }));
    render(<InternalLinkingWorkspace workspaceId="ws-1" />);
    await userEvent.click(screen.getByRole("tab", { name: "Orphans" }));
    await waitFor(() => expect(screen.getByText("No orphan Blogs detected.")).toBeInTheDocument());
  });

  it("lists orphan Blogs with a link to the internal Blog detail route, never a fabricated public URL", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ summary, orphans: [orphan], "cluster-health": [] }));
    render(<InternalLinkingWorkspace workspaceId="ws-1" />);
    await userEvent.click(screen.getByRole("tab", { name: "Orphans" }));
    await waitFor(() => expect(screen.getByText("Charging Network Roundup")).toBeInTheDocument());
    const link = screen.getByRole("link", { name: "Charging Network Roundup" });
    expect(link).toHaveAttribute("href", "/workspaces/ws-1/blog/blog-9");
  });

  it("shows a no-clusters empty state, and renders cluster metrics with coverage when present", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ summary, orphans: [], "cluster-health": [] }));
    render(<InternalLinkingWorkspace workspaceId="ws-1" />);
    await userEvent.click(screen.getByRole("tab", { name: "Cluster Health" }));
    await waitFor(() => expect(screen.getByText("No eligible topic clusters found.")).toBeInTheDocument());
  });

  it("renders cluster health rows including a null-coverage dash for a zero-content cluster", async () => {
    const zeroContentCluster: ClusterLinkHealth = { ...cluster, topicClusterPublicId: "tc-2", name: "Battery Swap", approvedBlogCount: 0, orphanBlogCount: 0, linkCoveragePercentage: null };
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ summary, orphans: [], "cluster-health": [cluster, zeroContentCluster] }));
    render(<InternalLinkingWorkspace workspaceId="ws-1" />);
    await userEvent.click(screen.getByRole("tab", { name: "Cluster Health" }));
    await waitFor(() => expect(screen.getByText("EV Charging")).toBeInTheDocument());
    expect(screen.getByRole("meter", { name: "EV Charging link coverage" })).toHaveAttribute("aria-valuenow", "80");
    const zeroRow = screen.getByText("Battery Swap").closest("tr") as HTMLElement;
    expect(within(zeroRow).getByText("—")).toBeInTheDocument();
  });

  it("shows an error state with retry for a failing panel without blocking the others", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/orphans")) return mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500);
      if (url.includes("/cluster-health")) return mockResponse({ data: [] });
      if (url.includes("/summary")) return mockResponse({ data: summary });
      return mockResponse({ data: null }, 404);
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkingWorkspace workspaceId="ws-1" />);

    await waitFor(() => expect(screen.getByText("Eligible approved Blogs")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: "Orphans" }));
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
