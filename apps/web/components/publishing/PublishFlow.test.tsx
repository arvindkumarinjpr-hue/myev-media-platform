import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublishFlow } from "./PublishFlow";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { account, testWorkspace } from "./publishingTestFixtures";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function renderFlow() {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions: ["PUBLISH_CREATE"] }}>
      <PublishFlow workspaceId="ws-1" />
    </SessionProvider>,
  );
}

// Phase 9.8 staging-UAT defect fix — the server already filters to
// APPROVED-only Blog/Video content (see PublishingQueryService.
// listPublishableContent()); this mock returns exactly what that
// endpoint returns, never a raw unfiltered Blog/Video list.
const contentCandidates = [
  { publicId: "blog-approved", title: "EV Tax Credits Explained", contentType: "BLOG" },
  { publicId: "video-approved", title: "Home EV charging", contentType: "VIDEO" },
];

function baseFetchMock(overrides: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response> | undefined> = {}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [key, handler] of Object.entries(overrides)) {
      if (url.includes(key)) {
        const result = handler(url, init);
        if (result) return result;
      }
    }
    if (url.includes("/publications/content-candidates")) return mockResponse({ data: contentCandidates });
    if (url.includes("/publishing/accounts")) return mockResponse({ data: [account({ publicId: "acct-video", channelType: "YOUTUBE", displayName: "MYEV Channel" })] });
    return mockResponse({ code: "NOT_FOUND", message: `not mocked: ${method} ${url}` }, 404);
  });
}

describe("PublishFlow", () => {
  afterEach(() => jest.restoreAllMocks());

  it("lists Approved content exactly as the server returns it, and only accounts eligible for the chosen content type", async () => {
    jest.spyOn(global, "fetch").mockImplementation(baseFetchMock() as unknown as typeof fetch);
    renderFlow();

    await waitFor(() => expect(screen.getByText("EV Tax Credits Explained")).toBeInTheDocument());
    expect(screen.getByText("Home EV charging")).toBeInTheDocument();

    // select the VIDEO item (second radio) so the YOUTUBE test account is eligible
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByText("MYEV Channel")).toBeInTheDocument());
  });

  it("does not offer a WordPress-only account for Video content", async () => {
    jest.spyOn(global, "fetch").mockImplementation(
      baseFetchMock({
        "/publishing/accounts": () => mockResponse({ data: [account({ publicId: "acct-wp", channelType: "WORDPRESS", displayName: "MYEV Blog" })] }),
      }) as unknown as typeof fetch,
    );
    renderFlow();
    await waitFor(() => expect(screen.getByText("Home EV charging")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText(/No connected accounts support this content type/)).toBeInTheDocument());
  });

  it("auto-drops a blocked account after the readiness check and blocks proceeding with zero remaining", async () => {
    jest.spyOn(global, "fetch").mockImplementation(
      baseFetchMock({
        "/publications/readiness": () =>
          mockResponse({ data: { ready: false, blockingReasons: ["CREDENTIAL_EXPIRED"], warnings: [], resolvedArtifact: null, metadata: {} } }),
      }) as unknown as typeof fetch,
    );
    renderFlow();
    await waitFor(() => expect(screen.getByText("Home EV charging")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("MYEV Channel")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Check Readiness" }));

    await waitFor(() => expect(screen.getByText("Blocked")).toBeInTheDocument());
    expect(screen.getByText("The stored credential for this account has expired.")).toBeInTheDocument();
    expect(screen.getByText(/No selected accounts are ready to publish/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("requires a future date to schedule, and submits the real create-publication contract on Publish now", async () => {
    const fetchMock = baseFetchMock({
      "/publications/readiness": () => mockResponse({ data: { ready: true, blockingReasons: [], warnings: [], resolvedArtifact: null, metadata: {} } }),
      "/publishing/publications": (url, init) => {
        if ((init?.method ?? "GET").toUpperCase() === "POST") return mockResponse({ data: { publicId: "pub-new" } });
        return undefined;
      },
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderFlow();

    await waitFor(() => expect(screen.getByText("Home EV charging")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("radio")[1]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByText("MYEV Channel")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(screen.getByRole("button", { name: "Check Readiness" }));
    await waitFor(() => expect(screen.getByText("Ready")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    // schedule step: "later" with no date is invalid
    await userEvent.click(screen.getByRole("radio", { name: "Schedule for later" }));
    expect(screen.getByText(/Choose a date and time in the future/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    // switch back to "now" and proceed to review/submit
    await userEvent.click(screen.getByRole("radio", { name: "Publish now" }));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/publishing/publications/pub-new"));
    const createCall = fetchMock.mock.calls.find((c) => c[0].toString().includes("/publishing/publications") && !c[0].toString().includes("content-candidates") && (c[1] as RequestInit)?.method === "POST")!;
    const body = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(body).toEqual({ contentItemPublicId: "video-approved", channelAccountPublicIds: ["acct-video"] });
  });
});
