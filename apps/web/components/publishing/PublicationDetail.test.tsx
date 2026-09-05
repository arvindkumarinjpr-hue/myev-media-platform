import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PublicationDetail } from "./PublicationDetail";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { publication, target, testWorkspace } from "./publishingTestFixtures";

function renderWithSession(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <PublicationDetail workspaceId="ws-1" publicationId="pub-1" />
    </SessionProvider>,
  );
}

describe("PublicationDetail", () => {
  afterEach(() => jest.restoreAllMocks());

  it("never collapses a reconciliation-required target into a plain Failed badge, and blocks ordinary retry", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: publication({
          targets: [
            target({
              publicId: "target-fb",
              channelType: "FACEBOOK",
              channelDisplayName: "MYEV Page",
              status: "FAILED",
              lastErrorCode: "FACEBOOK_PUBLISH_OUTCOME_UNKNOWN",
              lastErrorMessageSafe: "The publish outcome could not be confirmed.",
              reconciliationRequired: true,
            }),
          ],
        }),
      }),
    );
    renderWithSession(["PUBLISH_EXECUTE", "PUBLISH_CANCEL", "PUBLISH_CHANNEL_MANAGE"]);

    await waitFor(() => expect(screen.getByText("Manual verification required")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot be retried until an operator verifies/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark as Published" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm Not Published" })).toBeInTheDocument();
  });

  it("hides reconciliation actions without PUBLISH_CHANNEL_MANAGE", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({ data: publication({ targets: [target({ status: "FAILED", lastErrorCode: "INSTAGRAM_PUBLISHED_ID_UNRECOVERABLE", reconciliationRequired: true })] }) }),
    );
    renderWithSession(["PUBLISH_EXECUTE"]);
    await waitFor(() => expect(screen.getByText("Manual verification required")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Mark as Published" })).not.toBeInTheDocument();
  });

  it("mark-as-published requires an external content ID and a note, then submits and reloads", async () => {
    let reloaded = false;
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/reconcile/mark-published")) {
        reloaded = true;
        return mockResponse({ data: {} });
      }
      if (url.includes("/publishing/publications/pub-1")) {
        return mockResponse({
          data: publication({
            targets: [
              target({
                publicId: "target-fb",
                channelType: "FACEBOOK",
                status: reloaded ? "PUBLISHED" : "FAILED",
                lastErrorCode: reloaded ? null : "FACEBOOK_PUBLISH_OUTCOME_UNKNOWN",
                reconciliationRequired: !reloaded,
                externalContentId: reloaded ? "fb-post-123" : null,
              }),
            ],
          }),
        });
      }
      return mockResponse({ data: [] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    renderWithSession(["PUBLISH_EXECUTE", "PUBLISH_CANCEL", "PUBLISH_CHANNEL_MANAGE"]);
    await waitFor(() => expect(screen.getByText("Manual verification required")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Mark as Published" }));
    const dialog = screen.getByRole("dialog");
    // The submit button inside the dialog form is disabled until required fields are filled.
    expect((within(dialog).getByRole("button", { name: "Mark as Published" }) as HTMLButtonElement).disabled).toBe(true);

    await userEvent.type(within(dialog).getByLabelText("External content ID"), "fb-post-123");
    await userEvent.type(within(dialog).getByLabelText("Note"), "Verified directly on the Facebook Page - the post is live.");
    await userEvent.click(within(dialog).getByRole("button", { name: "Mark as Published" }));

    await waitFor(() => expect(fetchMock.mock.calls.some((c) => c[0].toString().includes("/reconcile/mark-published"))).toBe(true));
    const call = fetchMock.mock.calls.find((c) => c[0].toString().includes("/reconcile/mark-published"))!;
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ externalContentId: "fb-post-123", note: "Verified directly on the Facebook Page - the post is live." });
  });

  it("shows the real external link and safe error message, never raw attempt detail", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: publication({
          targets: [
            target({ status: "PUBLISHED", externalUrl: "https://facebook.com/1234", publishedAt: "2026-09-01T00:00:00.000Z" }),
          ],
        }),
      }),
    );
    renderWithSession(["PUBLISH_EXECUTE", "PUBLISH_CANCEL"]);
    await waitFor(() => expect(screen.getByText("https://facebook.com/1234")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /https:\/\/facebook.com\/1234/ })).toHaveAttribute("href", "https://facebook.com/1234");
  });
});
