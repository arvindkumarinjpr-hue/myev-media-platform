import { render, screen, waitFor } from "@testing-library/react";
import { KnowledgePackDetail } from "./KnowledgePackDetail";
import { SessionProvider } from "../../contexts/session-context";
import { makeKnowledgePack } from "../../lib/test-fixtures";
import { mockResponse } from "../../lib/test-mock-response";
import type { KnowledgePackDetail as KP, WorkspaceDetail } from "../../lib/types";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const workspace = {
  publicId: "ws-1",
  name: "Demo",
  slug: "demo",
  status: "ACTIVE",
  settings: {},
  featureFlags: {},
  myRole: "Owner",
} satisfies WorkspaceDetail;

function renderDetail(pack: KP, permissions: string[]) {
  jest.spyOn(global, "fetch").mockImplementation((input) => {
    const url = String(input);
    if (url.endsWith("/versions")) return Promise.resolve(mockResponse({ data: [] }));
    return Promise.resolve(mockResponse({ data: pack }));
  });
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <KnowledgePackDetail workspaceId="ws-1" knowledgePackId={pack.publicId} />
    </SessionProvider>,
  );
}

describe("KnowledgePackDetail lifecycle actions", () => {
  afterEach(() => jest.restoreAllMocks());

  it("Draft: offers Validate and a Delete danger-zone action for a permitted user, but no Archive", async () => {
    renderDetail(makeKnowledgePack({ status: "DRAFT" }), ["KP_VIEW", "KP_UPDATE", "KP_VALIDATE", "KP_DELETE"]);

    await waitFor(() => expect(screen.getByRole("heading", { name: "EV Content Pack" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Validate" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Danger zone" })).toHaveTextContent("Delete this Draft");
    expect(screen.queryByRole("button", { name: "Archive" })).not.toBeInTheDocument();
  });

  it("Draft: hides Validate and Delete when the user lacks the permissions", async () => {
    renderDetail(makeKnowledgePack({ status: "DRAFT" }), ["KP_VIEW"]);

    await waitFor(() => expect(screen.getByRole("heading", { name: "EV Content Pack" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Validate" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Danger zone" })).not.toBeInTheDocument();
  });

  it("Active: offers Create new version and an Archive danger-zone action, but no Validate or Delete", async () => {
    renderDetail(makeKnowledgePack({ status: "ACTIVE" }), ["KP_VIEW", "KP_UPDATE", "KP_VALIDATE", "KP_ARCHIVE", "KP_DELETE"]);

    await waitFor(() => expect(screen.getByRole("heading", { name: "EV Content Pack" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Create new version" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Danger zone" })).toHaveTextContent("Archive this version");
    expect(screen.queryByRole("button", { name: "Validate" })).not.toBeInTheDocument();
    expect(screen.queryByText("Delete this Draft")).not.toBeInTheDocument();
  });

  it("Active: renders the editor read-only", async () => {
    renderDetail(makeKnowledgePack({ status: "ACTIVE" }), ["KP_VIEW"]);

    await waitFor(() => expect(screen.getByRole("heading", { name: "EV Content Pack" })).toBeInTheDocument());
    expect((screen.getByLabelText("Name") as HTMLInputElement).readOnly).toBe(true);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });
});
