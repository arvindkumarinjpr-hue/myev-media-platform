import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectDetail } from "./ProjectDetail";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderDetail(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <ProjectDetail workspaceId="ws-1" projectId="proj-1" />
    </SessionProvider>,
  );
}

function mockLoad(project: { knowledgePackPublicId: string | null }) {
  jest
    .spyOn(global, "fetch")
    .mockResolvedValueOnce(mockResponse({ data: { publicId: "proj-1", name: "Demo Project", slug: "demo", status: "ACTIVE", ...project } }))
    .mockResolvedValueOnce(
      mockResponse({
        data: [
          { publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 2 },
          { publicId: "kp-2", name: "Draft Pack", status: "DRAFT", versionNumber: 1 },
        ],
      }),
    );
}

describe("ProjectDetail — Knowledge Pack assignment", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shows the currently assigned Knowledge Pack version — the Project's persisted FK is authoritative, no fabricated fallback", async () => {
    mockLoad({ knowledgePackPublicId: "kp-1" });
    renderDetail(["PROJECT_UPDATE"]);

    await waitFor(() => expect(screen.getByLabelText("Currently assigned")).toHaveValue("kp-1"));
    // Only Active packs are offered as assignment targets — the Draft one never appears as an option.
    expect(screen.queryByText("Draft Pack (v1)")).not.toBeInTheDocument();
  });

  it("only offers Active, same-workspace packs (already filtered by the workspace-scoped list call) plus Unassigned", async () => {
    mockLoad({ knowledgePackPublicId: null });
    renderDetail(["PROJECT_UPDATE"]);

    await waitFor(() => expect(screen.getByLabelText("Currently assigned")).toHaveValue("__unassigned__"));
    expect(screen.getByText("EV Pack (v2)")).toBeInTheDocument();
  });

  it("saves an explicit reassignment via PATCH — never automatic", async () => {
    mockLoad({ knowledgePackPublicId: null });
    renderDetail(["PROJECT_UPDATE"]);
    await waitFor(() => expect(screen.getByLabelText("Currently assigned")).toBeInTheDocument());

    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: { publicId: "proj-1", name: "Demo Project", slug: "demo", knowledgePackPublicId: "kp-1" } }));
    await userEvent.selectOptions(screen.getByLabelText("Currently assigned"), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Save assignment" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    // jest.spyOn on an already-mocked fetch reuses the same spy, so earlier
    // calls (the initial project + Knowledge Pack list loads) are still in
    // .mock.calls — the reassignment PATCH is the most recent one.
    const [url, init] = fetchSpy.mock.calls.at(-1)!;
    expect(url).toBe("/api/backend/workspaces/ws-1/projects/proj-1");
    expect(JSON.parse(init!.body as string)).toEqual({ knowledgePackId: "kp-1" });
  });

  it("disables reassignment for a user without PROJECT_UPDATE", async () => {
    mockLoad({ knowledgePackPublicId: "kp-1" });
    renderDetail(["PROJECT_VIEW"]);

    await waitFor(() => expect(screen.getByLabelText("Currently assigned")).toBeDisabled());
    expect(screen.queryByRole("button", { name: "Save assignment" })).not.toBeInTheDocument();
  });
});
