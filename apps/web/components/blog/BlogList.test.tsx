import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlogList } from "./BlogList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { listItem, testWorkspace } from "./blogTestFixtures";

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <BlogList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

describe("BlogList", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders real data: title, status, derived stage and pass/fail score", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          listItem({
            title: "Home EV charging guide",
            status: "IN_PROGRESS",
            brief: "APPROVED",
            outline: "APPROVED",
            draft: "READY",
            seo: "READY",
            qa: "COMPLETED",
            scoring: { status: "COMPLETED", passed: true, overallScore: 82 },
          }),
          listItem({ publicId: "b2", title: "Public charging", status: "APPROVED" }),
        ],
      }),
    );
    renderWithSession(["BLOG_VIEW", "BLOG_CREATE"]);

    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "Home EV charging guide" })).toBeInTheDocument());
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByText("82")).toBeInTheDocument();
    expect(screen.getByText("Passed")).toBeInTheDocument();
    // the APPROVED row shows a publish-ready badge (and its derived stage cell); the in-progress row shows neither
    expect(screen.getAllByText("Publish ready").length).toBeGreaterThanOrEqual(1);
  });

  it("shows an empty state with a Create action only when BLOG_CREATE is held", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    const { unmount } = renderWithSession(["BLOG_VIEW", "BLOG_CREATE"]);
    await waitFor(() => expect(screen.getByText("No blog articles yet")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Create the first one" })).toBeInTheDocument();
    unmount();

    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText("No blog articles yet")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "Create Blog" })).not.toBeInTheDocument();
  });

  it("filters by status and searches by title", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          listItem({ publicId: "a", title: "Home charging", status: "IN_PROGRESS" }),
          listItem({ publicId: "b", title: "Public charging etiquette", status: "REVIEW" }),
        ],
      }),
    );
    renderWithSession(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText("Home charging")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText("Filter blog articles by status"), "REVIEW");
    expect(screen.queryByText("Home charging")).not.toBeInTheDocument();
    expect(screen.getByText("Public charging etiquette")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Filter blog articles by status"), "");
    await userEvent.type(screen.getByLabelText("Search blog articles by title"), "etiquette");
    expect(screen.queryByText("Home charging")).not.toBeInTheDocument();
    expect(screen.getByText("Public charging etiquette")).toBeInTheDocument();
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
