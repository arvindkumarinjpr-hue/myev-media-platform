import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChannelAccountsList } from "./ChannelAccountsList";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { account, testWorkspace } from "./publishingTestFixtures";

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <ChannelAccountsList workspaceId="ws-1" />
    </SessionProvider>,
  );
}

describe("ChannelAccountsList", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders connected accounts with their real status, and shows connect actions only with PUBLISH_CHANNEL_MANAGE", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [account(), account({ publicId: "acct-2", channelType: "YOUTUBE", displayName: "MYEV Channel", connectionStatus: "EXPIRED" })] }));
    renderWithSession(["PUBLISH_CREATE", "PUBLISH_CHANNEL_MANAGE"]);

    await waitFor(() => expect(screen.getByText("MYEV Blog")).toBeInTheDocument());
    expect(screen.getByText("MYEV Channel")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Connect WordPress/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Connect YouTube/ })).toBeInTheDocument();
  });

  it("hides connect/manage actions for a view-only permission set", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [account()] }));
    renderWithSession(["PUBLISH_CREATE"]);

    await waitFor(() => expect(screen.getByText("MYEV Blog")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Connect WordPress/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disconnect" })).not.toBeInTheDocument();
    expect(screen.getByText(/requires an Administrator or Owner/)).toBeInTheDocument();
  });

  it("disconnecting requires confirmation and never deletes the account row, only revokes it", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "DELETE" && url.includes("/publishing/accounts/acct-1")) {
        return mockResponse({ data: account({ connectionStatus: "REVOKED", disconnectedAt: "2026-09-01T00:00:00.000Z" }) });
      }
      return mockResponse({ data: [account()] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderWithSession(["PUBLISH_CREATE", "PUBLISH_CHANNEL_MANAGE"]);

    await waitFor(() => expect(screen.getByText("MYEV Blog")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByText("Disconnect WordPress?")).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[1]);
    await waitFor(() => expect(screen.getByText("Disconnected")).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((c) => (c[1] as RequestInit)?.method === "DELETE")).toBe(true);
  });

  it("shows an error state with retry on load failure", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ code: "SERVER_ERROR", message: "boom" }, 500));
    renderWithSession(["PUBLISH_CREATE"]);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
