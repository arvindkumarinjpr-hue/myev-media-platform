import { render, screen, waitFor } from "@testing-library/react";
import { WorkspaceOverview } from "./WorkspaceOverview";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = {
  publicId: "ws-1",
  name: "Acme EV",
  slug: "acme-ev",
  status: "ACTIVE",
  settings: {},
  featureFlags: {},
  myRole: "Owner",
} satisfies WorkspaceDetail;

function renderOverview(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <WorkspaceOverview workspaceId="ws-1" />
    </SessionProvider>,
  );
}

const KP = [
  { publicId: "kp-1", name: "A", status: "ACTIVE", versionNumber: 1 },
  { publicId: "kp-2", name: "B", status: "DRAFT", versionNumber: 1 },
];
const RESEARCH = [
  { publicId: "r-1", status: "COMPLETED" },
  { publicId: "r-2", status: "RUNNING" },
  { publicId: "r-3", status: "COMPLETED" },
];
const CLUSTERS = [{ publicId: "tc-1" }];
const PROJECTS = [
  { publicId: "p-1", knowledgePackPublicId: "kp-1" },
  { publicId: "p-2", knowledgePackPublicId: null },
];

function mockAllLists() {
  jest
    .spyOn(global, "fetch")
    .mockImplementation((input) => {
      const url = String(input);
      if (url.includes("/knowledge-packs")) return Promise.resolve(mockResponse({ data: KP }));
      if (url.includes("/research")) return Promise.resolve(mockResponse({ data: RESEARCH }));
      if (url.includes("/topic-clusters")) return Promise.resolve(mockResponse({ data: CLUSTERS }));
      if (url.includes("/projects")) return Promise.resolve(mockResponse({ data: PROJECTS }));
      return Promise.resolve(mockResponse({ data: [] }));
    });
}

describe("WorkspaceOverview", () => {
  // global.fetch is a bare jest.fn() from jest.setup (not a spy), so its
  // call log survives restoreAllMocks — clear it before each test so the
  // "did not fetch X" assertion only sees this test's own calls.
  beforeEach(() => (global.fetch as jest.Mock).mockClear());
  afterEach(() => jest.restoreAllMocks());

  it("renders real metrics derived from the workspace's own resources", async () => {
    mockAllLists();
    renderOverview(["KP_VIEW", "RESEARCH_VIEW", "PROJECT_VIEW"]);

    const card = (label: string) => screen.getByText(label).closest("a, div") as HTMLElement;

    await waitFor(() => expect(card("Knowledge Packs")).toHaveTextContent("1 active"));
    expect(card("Knowledge Packs")).toHaveTextContent("2");
    expect(card("Research runs")).toHaveTextContent("3");
    expect(card("Research runs")).toHaveTextContent("2 completed");
    expect(card("Projects")).toHaveTextContent("1 without a Knowledge Pack");
  });

  it("shows only the quick actions the user has permission for", async () => {
    mockAllLists();
    renderOverview(["KP_VIEW", "RESEARCH_VIEW", "PROJECT_VIEW", "RESEARCH_RUN"]);

    await waitFor(() => expect(screen.getByRole("link", { name: /New Research/ })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /New Knowledge Pack/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /New Topic Cluster/ })).not.toBeInTheDocument();
  });

  it("does not fetch resources the user cannot view and shows a dash instead", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: CLUSTERS }));
    renderOverview([]);

    await waitFor(() => expect(screen.getByText("Topic Clusters").closest("a, div")).toHaveTextContent("1"));
    const calls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((u) => u.includes("/knowledge-packs"))).toBe(false);
    expect(calls.some((u) => u.includes("/research"))).toBe(false);
  });
});
