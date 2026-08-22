import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ValidationPanel } from "./ValidationPanel";
import { SessionProvider } from "../../contexts/session-context";
import { makeKnowledgePack } from "../../lib/test-fixtures";
import { mockResponse } from "../../lib/test-mock-response";
import type { WorkspaceDetail } from "../../lib/types";

const workspace = { publicId: "ws-1", name: "Demo", slug: "demo", status: "ACTIVE", settings: {}, featureFlags: {}, myRole: "Owner" } satisfies WorkspaceDetail;

function renderPanel(permissions: string[], onActivated = jest.fn()) {
  return render(
    <SessionProvider value={{ workspace, permissions }}>
      <ValidationPanel workspaceId="ws-1" knowledgePackId="kp-1" onActivated={onActivated} />
    </SessionProvider>,
  );
}

describe("ValidationPanel", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders nothing for a user without KP_VALIDATE", () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("displays every itemized gate failure clearly, identifying exactly what's missing, on a 422", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(
        mockResponse(
          { code: "KNOWLEDGE_VALIDATION_FAILED", message: "failed", details: ["At least one trusted knowledge source is required (FR-KP-002).", "A publishing strategy is required (FR-KP-004)."] },
          422,
        ),
      );
    renderPanel(["KP_VALIDATE"]);

    await userEvent.click(screen.getByRole("button", { name: "Validate" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/trusted knowledge source/)).toBeInTheDocument();
    expect(within(alert).getByText(/publishing strategy/)).toBeInTheDocument();
  });

  it("shows a link to Project management when a failure is a RESTRICT block", async () => {
    jest
      .spyOn(global, "fetch")
      .mockResolvedValue(mockResponse({ code: "KNOWLEDGE_VALIDATION_FAILED", message: "failed", details: ["Blocked by 1 Project(s) still referencing the predecessor version (Owner Decision 7, RESTRICT)."] }, 422));
    renderPanel(["KP_VALIDATE"]);

    await userEvent.click(screen.getByRole("button", { name: "Validate" }));

    await waitFor(() => expect(screen.getByText("Manage Project assignments")).toBeInTheDocument());
  });

  it("calls onActivated with the returned Active pack on success", async () => {
    const activated = makeKnowledgePack({ status: "ACTIVE" });
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: activated }));
    const onActivated = jest.fn();
    renderPanel(["KP_VALIDATE"], onActivated);

    await userEvent.click(screen.getByRole("button", { name: "Validate" }));

    await waitFor(() => expect(onActivated).toHaveBeenCalledWith(activated));
  });
});
