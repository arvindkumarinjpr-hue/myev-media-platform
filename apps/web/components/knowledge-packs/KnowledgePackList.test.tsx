import { render, screen, waitFor } from "@testing-library/react";
import { KnowledgePackList } from "./KnowledgePackList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <KnowledgePackList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

describe("KnowledgePackList", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows a loading state, then renders the list once data arrives", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [{ publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 2 }] }));
    renderWithSession(["KP_VIEW", "KP_CREATE"]);

    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("EV Pack")).toBeInTheDocument());
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("v2")).toBeInTheDocument();
  });

  it("shows an empty state with a create action when there are no packs and the user can create", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["KP_VIEW", "KP_CREATE"]);

    await waitFor(() => expect(screen.getByText("No Knowledge Packs yet")).toBeInTheDocument());
    expect(screen.getByText("Create the first one")).toBeInTheDocument();
  });

  it("hides the create action for a user without KP_CREATE — permission-aware, not just cosmetic", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["KP_VIEW"]);

    await waitFor(() => expect(screen.getByText("No Knowledge Packs yet")).toBeInTheDocument());
    expect(screen.queryByText("New Knowledge Pack")).not.toBeInTheDocument();
    expect(screen.queryByText("Create the first one")).not.toBeInTheDocument();
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["KP_VIEW"]);

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
