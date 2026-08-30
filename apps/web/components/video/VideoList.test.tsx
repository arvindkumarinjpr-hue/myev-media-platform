import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoList } from "./VideoList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { listItem, testWorkspace } from "./videoTestFixtures";

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <VideoList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

describe("VideoList", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders real data: title, target platform, derived stage, status", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          listItem({ title: "Home EV charging", status: "IN_PROGRESS", brief: "APPROVED", script: "APPROVED", scenePlan: "READY", render: "READY", seo: "READY" }),
          listItem({ publicId: "v2", title: "Public charging etiquette", status: "APPROVED", targetPlatform: "YOUTUBE_SHORTS" }),
        ],
      }),
    );
    renderWithSession(["VIDEO_VIEW", "VIDEO_CREATE"]);

    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("link", { name: "Home EV charging" })).toBeInTheDocument());
    expect(screen.getByText("Ready for review")).toBeInTheDocument();
    expect(screen.getByText(/YouTube — long-form/)).toBeInTheDocument();
    expect(screen.getByText(/YouTube Shorts/)).toBeInTheDocument();
    expect(screen.getAllByText("Publish ready").length).toBeGreaterThanOrEqual(1);
  });

  it("shows an empty state with a New Video action only when VIDEO_CREATE is held", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    const { unmount } = renderWithSession(["VIDEO_VIEW", "VIDEO_CREATE"]);
    await waitFor(() => expect(screen.getByText("No videos yet")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Create the first one" })).toBeInTheDocument();
    unmount();

    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["VIDEO_VIEW"]);
    await waitFor(() => expect(screen.getByText("No videos yet")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "New Video" })).not.toBeInTheDocument();
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
    renderWithSession(["VIDEO_VIEW"]);
    await waitFor(() => expect(screen.getByText("Home charging")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText("Filter videos by status"), "REVIEW");
    expect(screen.queryByText("Home charging")).not.toBeInTheDocument();
    expect(screen.getByText("Public charging etiquette")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Filter videos by status"), "");
    await userEvent.type(screen.getByLabelText("Search videos by title"), "etiquette");
    expect(screen.queryByText("Home charging")).not.toBeInTheDocument();
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["VIDEO_VIEW"]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
