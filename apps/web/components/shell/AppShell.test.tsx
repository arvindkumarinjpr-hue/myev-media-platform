import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./AppShell";

let pathname = "/workspaces/ws-1";
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: jest.fn(), refresh: jest.fn() }),
}));

function renderShell() {
  return render(
    <AppShell workspaceId="ws-1" workspaceName="Acme EV" role="Owner" permissions={["RESEARCH_VIEW", "KP_VIEW", "PROJECT_VIEW"]}>
      <p>Page body</p>
    </AppShell>,
  );
}

describe("AppShell", () => {
  it("renders a skip link and the page content", () => {
    renderShell();
    expect(screen.getByRole("link", { name: /skip to main content/i })).toHaveAttribute("href", "#main-content");
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });

  it("opens and closes the mobile navigation drawer", async () => {
    renderShell();

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));

    const drawer = screen.getByRole("dialog");
    expect(within(drawer).getByRole("link", { name: "Research" })).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("closes the drawer after a navigation link is followed", async () => {
    const { rerender } = renderShell();
    await userEvent.click(screen.getByRole("button", { name: "Open navigation menu" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Simulate the route changing (what clicking a link ultimately does).
    pathname = "/workspaces/ws-1/research";
    rerender(
      <AppShell workspaceId="ws-1" workspaceName="Acme EV" role="Owner" permissions={["RESEARCH_VIEW", "KP_VIEW", "PROJECT_VIEW"]}>
        <p>Page body</p>
      </AppShell>,
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    pathname = "/workspaces/ws-1";
  });
});
