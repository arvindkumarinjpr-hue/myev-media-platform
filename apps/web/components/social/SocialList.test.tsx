import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SocialList } from "./SocialList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";

const testWorkspace = { publicId: "ws-1", name: "Test Workspace" } as never;

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <SocialList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

function item(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    publicId: "sp-1",
    title: "EV Tax Credits — FACEBOOK post",
    status: "DRAFT",
    platform: "FACEBOOK",
    sourceContentItemPublicId: "blog-1",
    sourceContentType: "BLOG",
    caption: "Save thousands on your next EV purchase!",
    hasMedia: false,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("SocialList", () => {
  afterEach(() => jest.restoreAllMocks());

  it("lists real data: title, source type, platform, status, caption preview, media indicator", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          item(),
          item({
            publicId: "sp-2",
            title: "Charging network launch",
            platform: "INSTAGRAM",
            sourceContentType: "VIDEO",
            hasMedia: true,
            status: "APPROVED",
            caption: "New fast-charging stations now open across the region.",
          }),
          item({
            publicId: "sp-3",
            title: "Instagram launch teaser",
            platform: "INSTAGRAM",
            sourceContentType: "BLOG",
            hasMedia: false,
            status: "DRAFT",
            caption: "Coming soon.",
          }),
        ],
      }),
    );
    renderWithSession(["SOCIAL_VIEW"]);

    await waitFor(() => expect(screen.getByRole("link", { name: "EV Tax Credits — FACEBOOK post" })).toBeInTheDocument());
    expect(screen.getAllByText("Blog source").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Video source")).toBeInTheDocument();
    expect(screen.getByText(/Save thousands/)).toBeInTheDocument();
    expect(screen.getByText("Media required")).toBeInTheDocument();
    expect(screen.getByText("Attached")).toBeInTheDocument();
  });

  it("shows an empty state with New Social Post only when SOCIAL_CREATE is held", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    const { unmount } = renderWithSession(["SOCIAL_VIEW", "SOCIAL_CREATE"]);
    await waitFor(() => expect(screen.getByText("No social posts yet")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Create the first one" })).toBeInTheDocument();
    unmount();

    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText("No social posts yet")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "New Social Post" })).not.toBeInTheDocument();
  });

  it("filters by platform and by status", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [item({ publicId: "a", title: "Facebook draft", platform: "FACEBOOK", status: "DRAFT" }), item({ publicId: "b", title: "Instagram review", platform: "INSTAGRAM", status: "REVIEW" })],
      }),
    );
    renderWithSession(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText("Facebook draft")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText("Filter by platform"), "INSTAGRAM");
    expect(screen.queryByText("Facebook draft")).not.toBeInTheDocument();
    expect(screen.getByText("Instagram review")).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Filter by platform"), "");
    await userEvent.selectOptions(screen.getByLabelText("Filter by status"), "DRAFT");
    expect(screen.getByText("Facebook draft")).toBeInTheDocument();
    expect(screen.queryByText("Instagram review")).not.toBeInTheDocument();
  });

  it("shows an error state with retry on failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByText("Retry")).toBeInTheDocument();
  });
});
