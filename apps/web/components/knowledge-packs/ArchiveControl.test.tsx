import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ArchiveControl } from "./ArchiveControl";
import { SessionProvider } from "../../contexts/session-context";
import { makeKnowledgePack } from "../../lib/test-fixtures";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderControl(permissions: string[], onArchived = jest.fn()) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <ArchiveControl workspaceId="ws-1" knowledgePackId="kp-1" onArchived={onArchived} />
    </SessionProvider>,
  );
}

/** The trigger button and the confirm dialog's own button are both labeled "Archive" — the dialog's is always the second one once it's open. */
function confirmDialogButton(): HTMLElement {
  return screen.getAllByRole("button", { name: "Archive" })[1];
}

describe("ArchiveControl", () => {
  afterEach(() => jest.restoreAllMocks());

  it("is hidden entirely without KP_ARCHIVE", () => {
    const { container } = renderControl([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("requires confirmation before archiving, then succeeds", async () => {
    const archived = makeKnowledgePack({ status: "ARCHIVED" });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: archived }));
    const onArchived = jest.fn();
    renderControl(["KP_ARCHIVE"], onArchived);

    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    expect(onArchived).not.toHaveBeenCalled(); // not yet — confirmation still pending
    await userEvent.click(confirmDialogButton());

    await waitFor(() => expect(onArchived).toHaveBeenCalledWith(archived));
  });

  it("surfaces the RESTRICT conflict clearly rather than a raw error", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        mockResponse({ code: "KNOWLEDGE_CONFLICT", message: "Blocked by 1 Project(s) still referencing this version; reassign them before it can be archived (Owner Decision 7, RESTRICT)." }, 409),
      );
    renderControl(["KP_ARCHIVE"]);

    await userEvent.click(screen.getByRole("button", { name: "Archive" }));
    await userEvent.click(confirmDialogButton());

    await waitFor(() => expect(screen.getByText(/Blocked by 1 Project/)).toBeInTheDocument());
  });
});
