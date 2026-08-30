import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateVideoForm } from "./CreateVideoForm";
import { mockResponse } from "../../lib/test-mock-response";
import { pipeline } from "./videoTestFixtures";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

describe("CreateVideoForm", () => {
  afterEach(() => jest.restoreAllMocks());

  it("lists only ACTIVE Knowledge Packs and the six target platforms", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(
      mockResponse({
        data: [
          { publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 2 },
          { publicId: "kp-2", name: "Draft Pack", status: "DRAFT", versionNumber: 1 },
        ],
      }),
    );
    render(<CreateVideoForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByRole("form", { name: "New Video" })).toBeInTheDocument());

    expect(screen.getByRole("option", { name: "EV Pack (v2)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Draft Pack (v1)" })).not.toBeInTheDocument();

    const platform = screen.getByLabelText("Target platform");
    for (const label of [/YouTube — long-form/, /YouTube Shorts/, /Instagram Reel/, /Facebook Reel/, /Square social/, /Landscape presentation/]) {
      expect(screen.getByRole("option", { name: label })).toBeInTheDocument();
    }
    expect(platform).toHaveValue("YOUTUBE_LONG");
  });

  it("warns when no Knowledge Pack is active", async () => {
    jest.spyOn(global, "fetch").mockResolvedValue(mockResponse({ data: [{ publicId: "kp-2", name: "Draft", status: "DRAFT", versionNumber: 1 }] }));
    render(<CreateVideoForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByText("No active Knowledge Pack")).toBeInTheDocument());
  });

  it("rejects an out-of-range duration client-side and submits the real contract otherwise", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/video")) return mockResponse({ data: pipeline() });
      return mockResponse({ data: [{ publicId: "kp-1", name: "EV Pack", status: "ACTIVE", versionNumber: 1 }] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    render(<CreateVideoForm workspaceId="ws-1" />);
    await waitFor(() => expect(screen.getByRole("form", { name: "New Video" })).toBeInTheDocument());

    await userEvent.type(screen.getByLabelText("Topic"), "Home EV charging");
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack"), "kp-1");
    await userEvent.type(screen.getByLabelText(/Target duration/), "3");
    expect(screen.getByText(/between 5 and 7200/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create Video" })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText(/Target duration/));
    await userEvent.type(screen.getByLabelText(/Target duration/), "120");
    await userEvent.click(screen.getByRole("button", { name: "Create Video" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/video/video-1"));
    const body = JSON.parse((fetchMock.mock.calls.find((c) => (c[1] as RequestInit)?.method === "POST")![1] as RequestInit).body as string);
    expect(body).toEqual({ topic: "Home EV charging", knowledgePackVersionId: "kp-1", targetPlatform: "YOUTUBE_LONG", durationSecondsTarget: 120 });
  });
});
