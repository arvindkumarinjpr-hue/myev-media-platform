import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicationsList } from "./PublicationsList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { publication, target, testWorkspace } from "./publishingTestFixtures";

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <PublicationsList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

describe("PublicationsList", () => {
  afterEach(() => jest.restoreAllMocks());

  it("derives its summary cards from real target statuses, never a fabricated aggregate", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          publication({ publicId: "pub-1", contentTitle: "Home EV charging", targets: [target({ status: "PUBLISHED" })] }),
          publication({ publicId: "pub-2", contentTitle: "Public charging etiquette", targets: [target({ status: "FAILED", lastErrorMessageSafe: "The channel's own service is temporarily unavailable." })] }),
          publication({ publicId: "pub-3", contentTitle: "EV battery basics", targets: [target({ status: "QUEUED" })] }),
        ],
      }),
    );
    renderWithSession(["PUBLISH_CREATE"]);

    await waitFor(() => expect(screen.getByText("Home EV charging")).toBeInTheDocument());
    expect(screen.getByText("Failed / needs attention")).toBeInTheDocument();
    expect(screen.getByText("Pending / Scheduled / In progress")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New Publication" })).toBeInTheDocument();
    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Published").length).toBeGreaterThanOrEqual(1);
  });

  it("hides New Publication without PUBLISH_CREATE", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [publication()] }));
    renderWithSession([]);
    await waitFor(() => expect(screen.getByText("Home EV charging")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: "New Publication" })).not.toBeInTheDocument();
  });

  it("shows an empty state when there are no publications yet", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [] }));
    renderWithSession(["PUBLISH_CREATE"]);
    await waitFor(() => expect(screen.getByText("No publications yet")).toBeInTheDocument());
  });

  it("refetches with the selected status filter", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("status=FAILED")) return mockResponse({ data: [publication({ publicId: "pub-failed", targets: [target({ status: "FAILED" })] })] });
      return mockResponse({ data: [publication()] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderWithSession(["PUBLISH_CREATE"]);
    await waitFor(() => expect(screen.getByText("Home EV charging")).toBeInTheDocument());

    await userEvent.selectOptions(screen.getByLabelText("Filter by target status"), "FAILED");
    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0].toString().includes("status=FAILED"))).toBe(true));
  });
});
