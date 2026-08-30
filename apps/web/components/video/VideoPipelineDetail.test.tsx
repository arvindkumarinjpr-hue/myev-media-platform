import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { VideoPipelineDetail } from "./VideoPipelineDetail";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import {
  briefArtifact,
  pipeline,
  routeFetch,
  scenePlanArtifact,
  scoreFeedback,
  scriptArtifact,
  seoArtifact,
  testWorkspace,
  voiceCatalog,
} from "./videoTestFixtures";
import type { VideoPipeline } from "../../lib/types";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

const ALL = ["VIDEO_VIEW", "VIDEO_EDIT", "VIDEO_RENDER", "VIDEO_APPROVE", "SEO_EDIT", "SEO_SCORE", "MEDIA_VIEW"];

function renderDetail(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <VideoPipelineDetail workspaceId="ws-1" itemId="video-1" />
    </SessionProvider>,
  );
}

/** Standard mount routes: voice + score first (more specific), then the main read model. */
function mountRoutes(p: VideoPipeline, score: unknown = null) {
  return routeFetch({
    "video-1/voice": { voice: p.voice, voiceCatalog },
    "video-1/score": score,
    "video-1": p,
  });
}

describe("VideoPipelineDetail", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders the header, the 8-gate stepper and every stage panel from the read model", async () => {
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(pipeline()));
    renderDetail(ALL);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Home EV charging", level: 1 })).toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Progress" })).toBeInTheDocument();
    for (const g of ["Script Approved", "Assets Available", "Voice Generated", "Rendering Successful", "QA Passed", "SEO Complete", "Human Approval", "Publish Ready"]) {
      expect(screen.getByText(g)).toBeInTheDocument();
    }
    for (const panel of ["Brief", "Script", "Scene plan", "Assets", "Voice", "Subtitles", "Thumbnail", "SEO", "Render", "Quality assurance", "Content score", "Submit for review"]) {
      expect(screen.getByRole("heading", { name: panel, level: 2 })).toBeInTheDocument();
    }
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("shows Generate/Approve for the Script only with VIDEO_EDIT, and renders the artifact once ready", async () => {
    const p = pipeline({
      brief: { status: "READY", aiJobPublicId: "j", artifact: briefArtifact, failureReason: null },
      script: { status: "READY", aiJobPublicId: "j", artifact: scriptArtifact, failureReason: null, approvedAt: null, scriptApproved: false },
    });
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    const { unmount } = renderDetail(ALL);
    await waitFor(() => expect(screen.getByText("Plug in, pick a schedule, done.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Approve script (Gate #1)" })).toBeInTheDocument();
    unmount();

    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    renderDetail(["VIDEO_VIEW", "MEDIA_VIEW"]);
    await waitFor(() => expect(screen.getByText("Plug in, pick a schedule, done.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve script (Gate #1)" })).not.toBeInTheDocument();
  });

  it("gates the render trigger on VIDEO_RENDER, not VIDEO_EDIT", async () => {
    const p = pipeline({
      script: { status: "APPROVED", aiJobPublicId: "j", artifact: scriptArtifact, failureReason: null, approvedAt: "2026-08-30T00:00:00Z", scriptApproved: true },
      scenePlan: { status: "READY", aiJobPublicId: "j", artifact: scenePlanArtifact, failureReason: null },
      assets: { status: "READY", scenes: [], missingScenes: [], completedAt: "2026-08-30T00:00:00Z", failureReason: null },
      voice: { ...pipeline().voice, status: "READY", audioAssetPublicId: "a1", voiceProfileId: "en-in-neerja", audioDurationMs: 8000 },
      subtitles: { ...pipeline().subtitles, status: "READY", vttAssetPublicId: "vtt1", cueCount: 3 },
    });

    // VIDEO_EDIT but no VIDEO_RENDER — the submit button is not offered.
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    const { unmount } = renderDetail(["VIDEO_VIEW", "VIDEO_EDIT", "MEDIA_VIEW"]);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Render", level: 2 })).toBeInTheDocument());
    expect(screen.getByText(/Rendering is done by a Video Editor or an Administrator/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit render" })).not.toBeInTheDocument();
    unmount();

    // With VIDEO_RENDER the button is offered and enabled (prereqs met).
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit render" })).toBeEnabled());
  });

  it("polls only while a stage is running and stops once terminal", async () => {
    jest.useFakeTimers();
    try {
      const busy = pipeline({ brief: { status: "GENERATING", aiJobPublicId: "j", artifact: null, failureReason: null } });
      const done = pipeline({ brief: { status: "READY", aiJobPublicId: "j", artifact: briefArtifact, failureReason: null } });
      let calls = 0;
      const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("/voice")) return mockResponse({ data: { voice: busy.voice, voiceCatalog } });
        if (url.includes("/score")) return mockResponse({ data: null });
        calls += 1;
        return mockResponse({ data: calls >= 3 ? done : busy });
      });
      jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

      renderDetail(ALL);
      await act(async () => {
        await Promise.resolve();
      });
      const after1 = calls;
      await act(async () => {
        jest.advanceTimersByTime(2600);
        await Promise.resolve();
      });
      expect(calls).toBeGreaterThan(after1); // polled while GENERATING
      await act(async () => {
        jest.advanceTimersByTime(2600);
        await Promise.resolve();
        jest.advanceTimersByTime(2600);
        await Promise.resolve();
      });
      const settled = calls;
      await act(async () => {
        jest.advanceTimersByTime(6000);
        await Promise.resolve();
      });
      expect(calls).toBe(settled); // stopped once READY
    } finally {
      jest.useRealTimers();
    }
  });

  it("previews the rendered video securely via a presigned URL (MEDIA_VIEW)", async () => {
    const p = pipeline({
      render: { ...pipeline().render, status: "READY", renderedVideoPublicId: "vid-asset-1", outputWidth: 1920, outputHeight: 1080, outputDurationMs: 8000, exportProfileId: "YOUTUBE_LONG", completedAt: "2026-08-30T00:00:00Z" },
    });
    jest.spyOn(global, "fetch").mockImplementation(
      routeFetch({
        "assets/vid-asset-1/download-url": { downloadUrl: "https://minio.example/presigned", expiresAt: "2026-08-30T01:00:00Z" },
        "video-1/voice": { voice: p.voice, voiceCatalog },
        "video-1/score": null,
        "video-1": p,
      }),
    );
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByLabelText("Rendered video")).toBeInTheDocument());
    expect(screen.getByLabelText("Rendered video")).toHaveAttribute("src", "https://minio.example/presigned");

    // Without MEDIA_VIEW: the render is shown as complete but not previewed.
    jest.restoreAllMocks();
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "video-1/voice": { voice: p.voice, voiceCatalog }, "video-1/score": null, "video-1": p }));
    renderDetail(["VIDEO_VIEW"]);
    await waitFor(() => expect(screen.getByText(/You need MEDIA_VIEW to preview the video/)).toBeInTheDocument());
  });

  it("shows all six QA checks with pass/fail and the render prerequisite when not yet rendered", async () => {
    const checks = [
      { id: "missing_assets" as const, label: "Missing assets", passed: true, explanation: "All scenes have assets.", evidence: [] },
      { id: "audio_sync" as const, label: "Audio sync", passed: true, explanation: "Within tolerance.", evidence: [] },
      { id: "subtitle_sync" as const, label: "Subtitle sync", passed: true, explanation: "Aligned.", evidence: [] },
      { id: "resolution" as const, label: "Resolution", passed: true, explanation: "1920x1080.", evidence: [] },
      { id: "duration" as const, label: "Duration", passed: false, explanation: "12s over target.", evidence: ["expected 120s"], measured: 132, expected: 120 },
      { id: "branding" as const, label: "Branding", passed: true, explanation: "Watermark present.", evidence: [] },
    ];
    const p = pipeline({
      render: { ...pipeline().render, status: "READY", renderedVideoPublicId: "v1" },
      qa: { status: "COMPLETED", checks, passed: false, renderJobPublicId: "rj", renderedVideoPublicId: "v1", completedAt: "2026-08-30T00:00:00Z" },
    });
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Quality assurance", level: 2 })).toBeInTheDocument());
    for (const label of ["Missing assets", "Audio sync", "Subtitle sync", "Resolution", "Duration", "Branding"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByText("12s over target.")).toBeInTheDocument();
    expect(screen.getByText(/Measured 132/)).toBeInTheDocument();
  });

  it("shows the score: overall + universal categories + Video and Thumbnail dimensions", async () => {
    const p = pipeline({
      qa: { status: "COMPLETED", checks: [], passed: true, renderJobPublicId: "rj", renderedVideoPublicId: "v1", completedAt: "x" },
      seo: { status: "READY", aiJobPublicId: "j", artifact: seoArtifact, failureReason: null, seoComplete: true },
      score: { status: "COMPLETED", contentScorePublicId: "cs1", overallScore: 81, videoScore: 78, thumbnailScore: 71, passThreshold: 70, passed: true, ranAt: "x" },
    });
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p, scoreFeedback()));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByText("81")).toBeInTheDocument());
    expect(screen.getByText(/This video passes/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Video dimension score")).toBeInTheDocument());
    expect(screen.getByLabelText("Thumbnail dimension score")).toBeInTheDocument();
    expect(screen.getByLabelText("SEO score")).toBeInTheDocument();
  });

  it("submit-for-review is disabled with an itemized gate list until every gate passes", async () => {
    const p = pipeline({ reviewGatesUnmet: ["voice_generated", "rendering_successful", "qa_passed"], canSubmitForReview: false });
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled());
    expect(screen.getByText("Generate the narration (Gate #3)")).toBeInTheDocument();
    expect(screen.getByText("Pass all six QA checks (Gate #5)")).toBeInTheDocument();
  });

  it("approve / reject appear only for VIDEO_APPROVE and reject requires a comment", async () => {
    const inReview = pipeline({ contentItem: { publicId: "video-1", title: "Home EV charging", contentType: "VIDEO", status: "REVIEW" } });
    const approved = pipeline({ contentItem: { publicId: "video-1", title: "Home EV charging", contentType: "VIDEO", status: "APPROVED" }, publishReady: true });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/approve")) return mockResponse({ data: approved });
      if (url.includes("/voice")) return mockResponse({ data: { voice: inReview.voice, voiceCatalog } });
      if (url.includes("/score")) return mockResponse({ data: null });
      return mockResponse({ data: inReview });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    const { unmount } = renderDetail(["VIDEO_VIEW", "MEDIA_VIEW"]);
    await waitFor(() => expect(screen.getByText(/awaiting review by someone with VIDEO_APPROVE/)).toBeInTheDocument());
    unmount();

    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Comment/), "Looks good");
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.getAllByText("Publish ready").length).toBeGreaterThanOrEqual(1));
  });

  it("shows a clear failure + regenerate affordance for a failed AI stage (provider not configured)", async () => {
    const p = pipeline({ brief: { status: "FAILED", aiJobPublicId: "j", artifact: null, failureReason: "PROVIDER_NOT_CONFIGURED: no openai" } });
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByText(/media\/AI provider for this stage isn't configured/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Regenerate brief" })).toBeInTheDocument();
  });

  it("marks subtitles stale after a voice regeneration and never as a fake success", async () => {
    const p = pipeline({
      script: { status: "APPROVED", aiJobPublicId: "j", artifact: scriptArtifact, failureReason: null, approvedAt: "x", scriptApproved: true },
      voice: { ...pipeline().voice, status: "RUNNING", mediaJobPublicId: "mj" },
      subtitles: { ...pipeline().subtitles, status: "PENDING", failureReason: "voice was regenerated — rebuild subtitles" },
    });
    jest.spyOn(global, "fetch").mockImplementation(mountRoutes(p));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Subtitles", level: 2 })).toBeInTheDocument());
    expect(screen.getAllByText("Stale").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Rebuild the subtitles so their timing matches the new audio/)).toBeInTheDocument();
  });
});
