import { render, screen, waitFor } from "@testing-library/react";
import { ResearchList } from "./ResearchList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <ResearchList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

describe("ResearchList", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows a loading state, then renders the list once data arrives", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [{ publicId: "res-1", topic: "EV battery swap", status: "COMPLETED", createdAt: "2026-01-01T00:00:00.000Z" }] }));
    renderWithSession(["RESEARCH_VIEW", "RESEARCH_RUN"]);

    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("EV battery swap")).toBeInTheDocument());
    expect(screen.getByText("Completed")).toBeInTheDocument();
  });

  it("shows an empty state with a create action when there is no research and the user can run it", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["RESEARCH_VIEW", "RESEARCH_RUN"]);

    await waitFor(() => expect(screen.getByText("No research yet")).toBeInTheDocument());
    expect(screen.getByText("Start the first one")).toBeInTheDocument();
  });

  it("hides the create action for a user without RESEARCH_RUN — permission-aware, not just cosmetic", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["RESEARCH_VIEW"]);

    await waitFor(() => expect(screen.getByText("No research yet")).toBeInTheDocument());
    expect(screen.queryByText("New Research")).not.toBeInTheDocument();
    expect(screen.queryByText("Start the first one")).not.toBeInTheDocument();
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["RESEARCH_VIEW"]);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
