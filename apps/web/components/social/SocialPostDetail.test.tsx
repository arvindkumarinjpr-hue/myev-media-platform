import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SocialPostDetail } from "./SocialPostDetail";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";

const testWorkspace = { publicId: "ws-1", name: "Test Workspace" } as never;

function renderDetail(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <SocialPostDetail workspaceId="ws-1" itemId="sp-1" />
    </SessionProvider>,
  );
}

interface DetailFixture {
  publicId: string;
  title: string;
  status: string;
  platform: string;
  sourceContentItemPublicId: string;
  sourceContentType: string;
  sourceContentItemTitle: string;
  caption: string;
  hashtags: string[];
  ctaObjective: string;
  media: { mediaAssetPublicId: string; status: string; assetType: string } | null;
  currentVersion: { publicId: string; versionNumber: number; createdAt: string };
  versionCount: number;
  generation: { generated: true; captionAiJob: null; hashtagAiJob: null; createdAt: string } | null;
  createdAt: string;
  updatedAt: string;
}

function detail(overrides: Partial<DetailFixture> = {}): DetailFixture {
  return {
    publicId: "sp-1",
    title: "EV Tax Credits — FACEBOOK post",
    status: "DRAFT",
    platform: "FACEBOOK",
    sourceContentItemPublicId: "blog-1",
    sourceContentType: "BLOG",
    sourceContentItemTitle: "EV Tax Credits Explained",
    caption: "Save thousands on your next EV!",
    hashtags: ["ev", "taxcredit"],
    ctaObjective: "Learn more at our site",
    media: null,
    currentVersion: { publicId: "cv-1", versionNumber: 1, createdAt: "2026-09-01T00:00:00.000Z" },
    versionCount: 1,
    generation: { generated: true, captionAiJob: null, hashtagAiJob: null, createdAt: "2026-09-01T00:00:00.000Z" },
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function versions(d: ReturnType<typeof detail>) {
  return [
    {
      publicId: "cv-1",
      versionNumber: 1,
      isCurrent: true,
      caption: d.caption,
      hashtags: d.hashtags,
      ctaObjective: d.ctaObjective,
      generation: d.generation,
      media: d.media,
      createdAt: d.createdAt,
    },
  ];
}

function routeFetch(routes: Record<string, (init?: RequestInit) => Response | Promise<Response> | undefined>) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    for (const [key, handler] of Object.entries(routes)) {
      if (url.includes(key)) {
        const result = handler(init);
        if (result) return result;
      }
    }
    return mockResponse({ code: "NOT_FOUND", message: `not mocked: ${(init?.method ?? "GET").toUpperCase()} ${url}` }, 404);
  });
}

function baseRoutes(d: ReturnType<typeof detail>, extra: Record<string, (init?: RequestInit) => Response | Promise<Response> | undefined> = {}) {
  return {
    "/social-posts/sp-1/versions": () => mockResponse({ data: versions(d) }),
    "/social-posts/sp-1": (init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") return mockResponse({ data: d });
      return undefined;
    },
    "/publishing/accounts": () => mockResponse({ data: [] }),
    "/content-items/blog-1": () => mockResponse({ data: { publicId: "blog-1", title: "EV Tax Credits Explained", contentType: "BLOG", status: "APPROVED", featuredMediaAssetId: null } }),
    "/download-url": () => mockResponse({ data: { downloadUrl: "https://cdn.example.com/fake.jpg" } }),
    ...extra,
  };
}

describe("SocialPostDetail", () => {
  afterEach(() => jest.restoreAllMocks());

  it("loads and shows caption, hashtags, CTA and source", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch(baseRoutes(detail())) as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW"]);

    await waitFor(() => expect(screen.getByText("Save thousands on your next EV!")).toBeInTheDocument());
    expect(screen.getByText("ev")).toBeInTheDocument();
    expect(screen.getByText("taxcredit")).toBeInTheDocument();
    expect(screen.getByText(/CTA: Learn more at our site/)).toBeInTheDocument();
    expect(screen.getByText(/From Blog: EV Tax Credits Explained/)).toBeInTheDocument();
  });

  it("edit creates a new version — caption/hashtag/CTA changes are saved via PATCH", async () => {
    const fetchMock = jest.fn();
    let current = detail();
    fetchMock.mockImplementation(
      routeFetch(
        baseRoutes(current, {
          "/social-posts/sp-1": (init?: RequestInit) => {
            const method = (init?.method ?? "GET").toUpperCase();
            if (method === "GET") return mockResponse({ data: current });
            if (method === "PATCH") {
              const body = JSON.parse((init?.body as string) ?? "{}");
              current = { ...current, caption: body.caption, hashtags: body.hashtags, ctaObjective: body.ctaObjective };
              return mockResponse({ data: { publicId: "sp-1", status: "DRAFT", currentVersionId: "cv-2" } });
            }
            return undefined;
          },
        }),
      ),
    );
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT"]);

    await waitFor(() => expect(screen.getByText("Save thousands on your next EV!")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));

    const captionBox = screen.getByLabelText("Caption");
    await userEvent.clear(captionBox);
    await userEvent.type(captionBox, "Updated caption text");

    // hashtag add/remove
    const hashtagInput = screen.getByLabelText("Hashtags");
    await userEvent.type(hashtagInput, "newtag,");
    expect(screen.getByText("newtag")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove ev" }));
    expect(screen.queryByRole("button", { name: "Remove ev" })).not.toBeInTheDocument();

    // CTA edit
    const ctaBox = screen.getByLabelText(/CTA objective/);
    await userEvent.clear(ctaBox);
    await userEvent.type(ctaBox, "New CTA");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Updated caption text")).toBeInTheDocument());
    expect(screen.getByText(/CTA: New CTA/)).toBeInTheDocument();
  });

  it("regenerate calls the API and refreshes state", async () => {
    let current = detail();
    const fetchMock = jest.fn();
    fetchMock.mockImplementation(
      routeFetch(
        baseRoutes(current, {
          "/knowledge-packs": () => mockResponse({ data: [{ publicId: "kp-1", name: "Brand Voice", status: "ACTIVE", versionNumber: 2 }] }),
          "/social-posts/sp-1/regenerate": () => {
            current = { ...current, caption: "Freshly regenerated caption" };
            return mockResponse({ data: { publicId: "sp-1", status: "DRAFT", currentVersionId: "cv-2" } });
          },
          "/social-posts/sp-1": (init?: RequestInit) => ((init?.method ?? "GET").toUpperCase() === "GET" ? mockResponse({ data: current }) : undefined),
        }),
      ),
    );
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT"]);

    await waitFor(() => expect(screen.getByLabelText("Knowledge Pack for regeneration")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Knowledge Pack for regeneration"), "kp-1");
    await userEvent.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() => expect(screen.getByText("Freshly regenerated caption")).toBeInTheDocument());
  });

  it("media picker surfaces the Blog's featured image as a compatible candidate and allows detach", async () => {
    let current = detail({ media: { mediaAssetPublicId: "media-1", status: "ACTIVE", assetType: "IMAGE" } });
    const fetchMock = jest.fn();
    fetchMock.mockImplementation(
      routeFetch(
        baseRoutes(current, {
          "/content-items/blog-1": () => mockResponse({ data: { publicId: "blog-1", title: "EV Tax Credits Explained", contentType: "BLOG", status: "APPROVED", featuredMediaAssetId: "media-2" } }),
          "/social-posts/sp-1": (init?: RequestInit) => {
            const method = (init?.method ?? "GET").toUpperCase();
            if (method === "GET") return mockResponse({ data: current });
            if (method === "PATCH") {
              const body = JSON.parse((init?.body as string) ?? "{}");
              current = { ...current, media: body.mediaAssetPublicId === null ? null : { mediaAssetPublicId: body.mediaAssetPublicId, status: "ACTIVE", assetType: "IMAGE" } };
              return mockResponse({ data: { publicId: "sp-1", status: "DRAFT", currentVersionId: "cv-2" } });
            }
            return undefined;
          },
        }),
      ),
    );
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT", "BLOG_VIEW"]);

    await waitFor(() => expect(screen.getByText("Blog's featured image")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Use this" }));
    await waitFor(() => expect(screen.getByText("IMAGE · ACTIVE")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Detach media" }));
    await waitFor(() => expect(screen.getByText(/No media attached/)).toBeInTheDocument());
  });

  it("media picker surfaces a platform-matched Video render as a candidate", async () => {
    const videoDetail = detail({ sourceContentType: "VIDEO", sourceContentItemPublicId: "video-1", platform: "INSTAGRAM" });
    jest.spyOn(global, "fetch").mockImplementation(
      routeFetch(
        baseRoutes(videoDetail, {
          "/video/video-1": () =>
            mockResponse({
              data: {
                contentItem: { publicId: "video-1", title: "Charging demo", contentType: "VIDEO", status: "APPROVED" },
                videoScript: { publicId: "vs-1", targetPlatform: "INSTAGRAM_REEL", exportProfile: null, durationSecondsTarget: null },
                render: { status: "READY", renderJobPublicId: "rj-1", renderedVideoPublicId: "render-1", renderedVideoAssetGroupId: null, exportProfileId: null, attempt: 1, expectedDurationMs: null, outputWidth: null, outputHeight: null, outputDurationMs: null, outputByteSize: null, completedAt: null, failureReason: null },
              },
            }),
        }),
      ) as unknown as typeof fetch,
    );
    renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT", "VIDEO_VIEW"]);

    await waitFor(() => expect(screen.getByText(/existing instagram reel render/i)).toBeInTheDocument());
  });

  it("Facebook caption-only readiness shows Ready with no connected account note when none exists", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch(baseRoutes(detail())) as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText(/No connected Facebook account/)).toBeInTheDocument());
  });

  it("Instagram with no media shows a truthful 'media required' readiness warning", async () => {
    const igDetail = detail({ platform: "INSTAGRAM" });
    jest.spyOn(global, "fetch").mockImplementation(
      routeFetch(
        baseRoutes(igDetail, {
          "/publishing/accounts": () => mockResponse({ data: [{ publicId: "acct-ig", channelType: "INSTAGRAM", connectionStatus: "CONNECTED", displayName: "MYEV IG", externalAccountId: "1", tokenExpiresAt: null, lastVerifiedAt: null, disconnectedAt: null, createdAt: "", updatedAt: "" }] }),
          "/publications/readiness": () => mockResponse({ data: { ready: false, blockingReasons: ["SOCIAL_MEDIA_REQUIRED"], warnings: [], resolvedArtifact: null, metadata: {} } }),
        }),
      ) as unknown as typeof fetch,
    );
    renderDetail(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText("This platform requires media, and none is attached.")).toBeInTheDocument());
  });

  it("incompatible media shows the SOCIAL_MEDIA_INCOMPATIBLE warning truthfully", async () => {
    const igDetail = detail({ platform: "INSTAGRAM", media: { mediaAssetPublicId: "media-3", status: "ACTIVE", assetType: "DOCUMENT" } });
    jest.spyOn(global, "fetch").mockImplementation(
      routeFetch(
        baseRoutes(igDetail, {
          "/publishing/accounts": () => mockResponse({ data: [{ publicId: "acct-ig", channelType: "INSTAGRAM", connectionStatus: "CONNECTED", displayName: "MYEV IG", externalAccountId: "1", tokenExpiresAt: null, lastVerifiedAt: null, disconnectedAt: null, createdAt: "", updatedAt: "" }] }),
          "/publications/readiness": () => mockResponse({ data: { ready: false, blockingReasons: ["SOCIAL_MEDIA_INCOMPATIBLE"], warnings: [], resolvedArtifact: null, metadata: {} } }),
        }),
      ) as unknown as typeof fetch,
    );
    renderDetail(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText("The attached media isn't in a supported state or type for this platform.")).toBeInTheDocument());
  });

  it("shows the Facebook image-not-yet-supported caveat without misrepresenting it as externally publishable", async () => {
    const fbImageDetail = detail({ media: { mediaAssetPublicId: "media-4", status: "ACTIVE", assetType: "IMAGE" } });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch(baseRoutes(fbImageDetail)) as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText(/Facebook image posting is not implemented yet/)).toBeInTheDocument());
  });

  it("submit for review is available with SOCIAL_EDIT in an editable state", async () => {
    let current = detail();
    jest.spyOn(global, "fetch").mockImplementation(
      routeFetch(
        baseRoutes(current, {
          "/submit-for-review": () => {
            current = { ...current, status: "REVIEW" };
            return mockResponse({ data: { publicId: "sp-1", status: "REVIEW" } });
          },
          "/social-posts/sp-1": (init?: RequestInit) => ((init?.method ?? "GET").toUpperCase() === "GET" ? mockResponse({ data: current }) : undefined),
        }),
      ) as unknown as typeof fetch,
    );
    renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit for review" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Submit for review" }));
    await waitFor(() => expect(screen.getByText("In review")).toBeInTheDocument());
  });

  it("REVIEW state disables editing and shows approve/reject only for SOCIAL_APPROVE", async () => {
    const reviewDetail = detail({ status: "REVIEW" });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch(baseRoutes(reviewDetail)) as unknown as typeof fetch);

    // Publisher / view-only: no Edit button, no approve/reject.
    const { unmount } = renderDetail(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText("Save thousands on your next EV!")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.getByText(/awaiting review by someone with SOCIAL_APPROVE/)).toBeInTheDocument();
    unmount();

    // A Writer (SOCIAL_EDIT only, no SOCIAL_APPROVE) also cannot approve — and REVIEW is not an editable status.
    const { unmount: unmount2 } = renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT"]);
    await waitFor(() => expect(screen.getByText("Save thousands on your next EV!")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    unmount2();

    // Owner/Administrator/Content Manager tier (SOCIAL_APPROVE) sees approve/reject.
    renderDetail(["SOCIAL_VIEW", "SOCIAL_APPROVE"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("approve transitions to Approved and reject requires a comment", async () => {
    let current = detail({ status: "REVIEW" });
    jest.spyOn(global, "fetch").mockImplementation(
      routeFetch(
        baseRoutes(current, {
          "/approve": () => {
            current = { ...current, status: "APPROVED" };
            return mockResponse({ data: { publicId: "sp-1", status: "APPROVED" } });
          },
          "/social-posts/sp-1": (init?: RequestInit) => ((init?.method ?? "GET").toUpperCase() === "GET" ? mockResponse({ data: current }) : undefined),
        }),
      ) as unknown as typeof fetch,
    );
    renderDetail(["SOCIAL_VIEW", "SOCIAL_APPROVE"]);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getByText("Approved", { selector: "strong" })).toBeInTheDocument());
    expect(screen.getByText(/and read-only/)).toBeInTheDocument();
  });

  it("APPROVED is read-only with a Send to Publishing handoff, and no direct publish control", async () => {
    const approved = detail({ status: "APPROVED" });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch(baseRoutes(approved)) as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW", "SOCIAL_EDIT", "SOCIAL_APPROVE"]);

    await waitFor(() => expect(screen.getByRole("link", { name: "Send to Publishing" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "Send to Publishing" })).toHaveAttribute("href", "/workspaces/ws-1/publishing/publications/new?contentItemId=sp-1");
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Publish Now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Schedule/i })).not.toBeInTheDocument();
  });

  it("shows version history with per-version caption/hashtags/media", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch(baseRoutes(detail())) as unknown as typeof fetch);
    renderDetail(["SOCIAL_VIEW"]);
    await waitFor(() => expect(screen.getByText("Version 1")).toBeInTheDocument());
    expect(screen.getByText("Current")).toBeInTheDocument();
    expect(screen.getByText("Media: None attached")).toBeInTheDocument();
  });
});
