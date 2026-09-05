import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConnectWordPressForm } from "./ConnectWordPressForm";
import { mockResponse } from "../../lib/test-mock-response";
import { account } from "./publishingTestFixtures";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("ConnectWordPressForm", () => {
  afterEach(() => jest.restoreAllMocks());

  it("submits the real connect contract and clears the password field on failure without echoing it back", async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => mockResponse({ code: "PUBLISHING_WORDPRESS_VALIDATION_FAILED", message: "Could not authenticate with the WordPress site." }, 422));
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    render(<ConnectWordPressForm workspaceId="ws-1" />);
    await userEvent.type(screen.getByLabelText("Site URL"), "https://example.com");
    await userEvent.type(screen.getByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Application Password"), "abcd-1234-efgh-5678");
    await userEvent.type(screen.getByLabelText("Display name"), "MYEV Blog");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(screen.getByText("Could not authenticate with the WordPress site.")).toBeInTheDocument());
    expect((screen.getByLabelText("Application Password") as HTMLInputElement).value).toBe("");

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ siteUrl: "https://example.com", username: "admin", applicationPassword: "abcd-1234-efgh-5678", displayName: "MYEV Blog" });
  });

  it("navigates back to Channel Accounts on success", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: account() }));
    render(<ConnectWordPressForm workspaceId="ws-1" />);
    await userEvent.type(screen.getByLabelText("Site URL"), "https://example.com");
    await userEvent.type(screen.getByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Application Password"), "abcd-1234-efgh-5678");
    await userEvent.type(screen.getByLabelText("Display name"), "MYEV Blog");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/publishing/accounts"));
  });

  it("rotation mode has no Display name field and submits to the rotate contract", async () => {
    const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => mockResponse({ data: account() }));
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    render(<ConnectWordPressForm workspaceId="ws-1" accountId="acct-1" />);
    expect(screen.queryByLabelText("Display name")).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Site URL"), "https://example.com");
    await userEvent.type(screen.getByLabelText("Username"), "admin");
    await userEvent.type(screen.getByLabelText("Application Password"), "new-pass-1234");
    await userEvent.click(screen.getByRole("button", { name: "Update Credential" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url.toString()).toContain("/publishing/accounts/acct-1/wordpress/credential");
    expect((init as RequestInit).method).toBe("PUT");
  });
});
