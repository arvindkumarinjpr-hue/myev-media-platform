import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateSocialPostFlow } from "./CreateSocialPostFlow";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";

const push = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const testWorkspace = { publicId: "ws-1", name: "Test Workspace" } as never;

function renderFlow() {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions: ["SOCIAL_CREATE"] }}>
      <CreateSocialPostFlow workspaceId="ws-1" />
    </SessionProvider>,
  );
}

const blogs = [{ publicId: "blog-1", title: "EV Tax Credits Explained", contentType: "BLOG", status: "APPROVED", featuredMediaAssetId: "media-1" }];
const videos = [{ publicId: "video-1", title: "Home EV charging", contentType: "VIDEO", status: "APPROVED", featuredMediaAssetId: null }];
const packs = [{ publicId: "kp-1", name: "Brand Voice", status: "ACTIVE", versionNumber: 3 }];

function baseFetchMock(overrides: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response> | undefined> = {}) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    for (const [key, handler] of Object.entries(overrides)) {
      if (url.includes(key)) {
        const result = handler(url, init);
        if (result) return result;
      }
    }
    if (url.includes("contentType=BLOG")) return mockResponse({ data: blogs });
    if (url.includes("contentType=VIDEO")) return mockResponse({ data: videos });
    if (url.includes("/knowledge-packs")) return mockResponse({ data: packs });
    return mockResponse({ code: "NOT_FOUND", message: `not mocked: ${url}` }, 404);
  });
}

describe("CreateSocialPostFlow", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    push.mockClear();
  });

  it("only shows APPROVED Blog and Video sources — both selectable", async () => {
    jest.spyOn(global, "fetch").mockImplementation(baseFetchMock() as unknown as typeof fetch);
    renderFlow();

    await waitFor(() => expect(screen.getByText("EV Tax Credits Explained")).toBeInTheDocument());
    expect(screen.getByText("Home EV charging")).toBeInTheDocument();
    expect(screen.getByText("Blog")).toBeInTheDocument();
    expect(screen.getByText("Video")).toBeInTheDocument();
  });

  it("shows an empty state when there is no eligible source content", async () => {
    jest.spyOn(global, "fetch").mockImplementation(
      baseFetchMock({ "contentType=BLOG": () => mockResponse({ data: [] }), "contentType=VIDEO": () => mockResponse({ data: [] }) }) as unknown as typeof fetch,
    );
    renderFlow();
    await waitFor(() => expect(screen.getByText("No Approved Blog or Video content")).toBeInTheDocument());
  });

  it("offers Facebook and Instagram as platforms, and no others", async () => {
    jest.spyOn(global, "fetch").mockImplementation(baseFetchMock() as unknown as typeof fetch);
    renderFlow();
    await waitFor(() => expect(screen.getByText("EV Tax Credits Explained")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("radio")[0]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText("Facebook")).toBeInTheDocument();
    expect(screen.getByText("Instagram")).toBeInTheDocument();
    expect(screen.queryByText("WordPress")).not.toBeInTheDocument();
    expect(screen.queryByText("YouTube")).not.toBeInTheDocument();
  });

  it("runs the full flow through to a real create+generate call and navigates to the new post", async () => {
    const fetchMock = baseFetchMock({
      "/social-posts": (url, init) => {
        if ((init?.method ?? "GET").toUpperCase() === "POST") return mockResponse({ data: { publicId: "sp-new", status: "DRAFT" } });
        return undefined;
      },
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderFlow();

    await waitFor(() => expect(screen.getByText("EV Tax Credits Explained")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("radio")[0]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    await userEvent.click(screen.getByLabelText("Facebook"));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(screen.getByLabelText(/Knowledge Pack/)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText(/Knowledge Pack/), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(screen.getByText(/Generating a real caption/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/workspaces/ws-1/social/sp-new"));
    const createCall = fetchMock.mock.calls.find((c) => c[0].toString().endsWith("/social-posts") && (c[1] as RequestInit)?.method === "POST")!;
    const body = JSON.parse((createCall[1] as RequestInit).body as string);
    expect(body).toEqual({ sourceContentItemId: "blog-1", platform: "FACEBOOK", knowledgePackVersionId: "kp-1" });
  });

  it("shows a generation failure without navigating away", async () => {
    const fetchMock = baseFetchMock({
      "/social-posts": (url, init) => {
        if ((init?.method ?? "GET").toUpperCase() === "POST") return mockResponse({ code: "SOCIAL_CAPTION_GENERATION_FAILED", message: "Caption generation failed." }, 422);
        return undefined;
      },
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderFlow();

    await waitFor(() => expect(screen.getByText("EV Tax Credits Explained")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("radio")[0]);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByLabelText("Facebook"));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByLabelText(/Knowledge Pack/)).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText(/Knowledge Pack/), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() => expect(screen.getByText("Caption generation failed.")).toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
  });
});
