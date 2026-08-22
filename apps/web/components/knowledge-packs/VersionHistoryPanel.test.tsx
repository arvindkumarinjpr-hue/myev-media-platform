import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VersionHistoryPanel } from "./VersionHistoryPanel";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderPanel(permissions: string[], currentStatus: "DRAFT" | "ACTIVE" | "ARCHIVED" = "ACTIVE") {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <VersionHistoryPanel workspaceId="ws-1" knowledgePackId="kp-1" currentStatus={currentStatus} />
    </SessionProvider>,
  );
}

describe("VersionHistoryPanel", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("lists every version with its status and predecessor relation", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          { publicId: "kp-1", name: "Pack", status: "ARCHIVED", versionNumber: 1, currentVersionOfPublicId: null, createdAt: "", updatedAt: "", archivedAt: "2026-08-22T00:00:00.000Z" },
          { publicId: "kp-2", name: "Pack", status: "ACTIVE", versionNumber: 2, currentVersionOfPublicId: "kp-1", createdAt: "", updatedAt: "", archivedAt: null },
        ],
      }),
    );
    renderPanel(["KP_VIEW"], "ACTIVE");

    await waitFor(() => expect(screen.getByText("v1")).toBeInTheDocument());
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("root")).toBeInTheDocument();
    expect(screen.getByText("successor")).toBeInTheDocument();
  });

  it("creates a new Draft version from Active and navigates to it, only when KP_UPDATE + status is ACTIVE", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(mockResponse({ data: [] }))
      .mockResolvedValueOnce(mockResponse({ data: { publicId: "kp-2" } }, 201));
    renderPanel(["KP_UPDATE", "KP_VIEW"], "ACTIVE");

    await userEvent.click(screen.getByRole("button", { name: "Create new Draft version" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/knowledge-packs/kp-2"));
  });

  it("does not offer version creation for a Draft (only Active can spawn a successor)", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderPanel(["KP_UPDATE", "KP_VIEW"], "DRAFT");

    await waitFor(() => expect(screen.queryByRole("button", { name: "Create new Draft version" })).not.toBeInTheDocument());
  });

  it("does not offer version creation without KP_UPDATE, even on an Active pack", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderPanel(["KP_VIEW"], "ACTIVE");

    await waitFor(() => expect(screen.queryByRole("button", { name: "Create new Draft version" })).not.toBeInTheDocument());
  });
});
