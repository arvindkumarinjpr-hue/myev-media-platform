import { render, screen } from "@testing-library/react";
import { SidebarNav } from "./SidebarNav";

let pathname = "/workspaces/ws-1/research";
jest.mock("next/navigation", () => ({ usePathname: () => pathname }));

const ALL = ["RESEARCH_VIEW", "KP_VIEW", "PROJECT_VIEW", "TOPIC_CLUSTER_MANAGE"];

describe("SidebarNav", () => {
  it("renders the grouped primary navigation", () => {
    pathname = "/workspaces/ws-1";
    render(<SidebarNav workspaceId="ws-1" permissions={ALL} />);

    expect(screen.getByRole("link", { name: "Overview" })).toHaveAttribute("href", "/workspaces/ws-1");
    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("href", "/workspaces/ws-1/research");
    expect(screen.getByRole("link", { name: "Knowledge Packs" })).toBeInTheDocument();
    expect(screen.getByText("Intelligence")).toBeInTheDocument();
    expect(screen.getByText("Content Foundation")).toBeInTheDocument();
  });

  it("marks the active section (including nested detail routes) with aria-current", () => {
    pathname = "/workspaces/ws-1/research/abc-123";
    render(<SidebarNav workspaceId="ws-1" permissions={ALL} />);

    expect(screen.getByRole("link", { name: "Research" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overview" })).not.toHaveAttribute("aria-current");
  });

  it("hides items the user lacks permission for", () => {
    pathname = "/workspaces/ws-1";
    render(<SidebarNav workspaceId="ws-1" permissions={["KP_VIEW"]} />);

    expect(screen.getByRole("link", { name: "Knowledge Packs" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Research" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Projects" })).not.toBeInTheDocument();
    // Topic Clusters has no view-permission gate — always visible.
    expect(screen.getByRole("link", { name: "Topic Clusters" })).toBeInTheDocument();
  });
});
