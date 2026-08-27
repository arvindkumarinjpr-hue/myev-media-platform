import { render, screen } from "@testing-library/react";
import { WorkspaceGrid } from "./WorkspaceGrid";
import type { WorkspaceSummary } from "../../lib/types";

describe("WorkspaceGrid", () => {
  it("renders a card per workspace linking to its Overview", () => {
    const workspaces: WorkspaceSummary[] = [
      { publicId: "ws-1", name: "Acme EV", slug: "acme-ev", status: "ACTIVE" },
      { publicId: "ws-2", name: "Beta Media", slug: "beta-media", status: "ARCHIVED" },
    ];
    render(<WorkspaceGrid workspaces={workspaces} />);

    expect(screen.getByRole("link", { name: /Acme EV/ })).toHaveAttribute("href", "/workspaces/ws-1");
    expect(screen.getByRole("link", { name: /Beta Media/ })).toHaveAttribute("href", "/workspaces/ws-2");
    expect(screen.getByText("Archived")).toBeInTheDocument();
  });

  it("shows an empty state when the user has no workspaces", () => {
    render(<WorkspaceGrid workspaces={[]} />);
    expect(screen.getByText("No workspaces yet")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
