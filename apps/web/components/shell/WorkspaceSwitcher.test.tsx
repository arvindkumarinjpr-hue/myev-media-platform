import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { mockResponse } from "../../lib/test-mock-response";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }) }));

describe("WorkspaceSwitcher", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shows the current workspace and role, and opens a list of workspaces to switch to", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          { publicId: "ws-1", name: "Acme EV", slug: "acme-ev", status: "ACTIVE" },
          { publicId: "ws-2", name: "Beta Media", slug: "beta-media", status: "ACTIVE" },
        ],
      }),
    );

    render(<WorkspaceSwitcher workspaceId="ws-1" workspaceName="Acme EV" role="Owner" />);

    const trigger = screen.getByRole("button", { name: /Acme EV/ });
    expect(trigger).toHaveTextContent("Owner");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");

    const menu = await screen.findByRole("menu", { name: "Switch workspace" });
    await waitFor(() => expect(within(menu).getByRole("menuitem", { name: /Beta Media/ })).toBeInTheDocument());

    expect(within(menu).getByRole("menuitem", { name: /Acme EV/ })).toHaveAttribute("aria-current", "true");
    expect(within(menu).getByRole("menuitem", { name: "View all workspaces" })).toHaveAttribute("href", "/workspaces");
  });
});
