import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BlogPipelineDetail } from "./BlogPipelineDetail";
import { SessionProvider } from "../../contexts/session-context";
import { mockResponse } from "../../lib/test-mock-response";
import { briefArtifact, draftArtifact, outlineArtifact, pipeline, routeFetch, scoreFeedback, seoArtifact, testWorkspace } from "./blogTestFixtures";
import type { BlogPipeline } from "../../lib/types";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

function renderDetail(permissions: string[]) {
  return render(
    <SessionProvider value={{ workspace: testWorkspace, permissions }}>
      <BlogPipelineDetail workspaceId="ws-1" itemId="blog-1" />
    </SessionProvider>,
  );
}

const ALL = ["BLOG_VIEW", "BLOG_EDIT", "BLOG_APPROVE", "SEO_EDIT", "SEO_SCORE"];

describe("BlogPipelineDetail", () => {
  afterEach(() => jest.restoreAllMocks());

  it("renders the header, stepper and every stage panel from the read model", async () => {
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": pipeline() }));
    renderDetail(ALL);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Home EV charging guide", level: 1 })).toBeInTheDocument());
    expect(screen.getByRole("list", { name: "Progress" })).toBeInTheDocument();
    for (const t of ["Brief", "Outline", "Draft", "SEO", "Internal linking", "Quality assurance", "Content score", "Submit for review"]) {
      expect(screen.getByRole("heading", { name: t, level: 2 })).toBeInTheDocument();
    }
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("shows Generate/Approve for the Brief only with BLOG_EDIT, and renders the artifact once ready", async () => {
    const p = pipeline({ brief: { status: "READY", aiJobPublicId: "job-1", artifact: briefArtifact, approvedAt: null, failureReason: null } });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": p }));

    const { unmount } = renderDetail(ALL);
    await waitFor(() => expect(screen.getByText("home ev charging")).toBeInTheDocument());
    expect(screen.getByText("New EV owners")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve brief" })).toBeInTheDocument();
    unmount();

    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": p }));
    renderDetail(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText("home ev charging")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve brief" })).not.toBeInTheDocument();
  });

  it("shows a clear failure + regenerate affordance for a failed AI stage (provider not configured)", async () => {
    const p = pipeline({ brief: { status: "FAILED", aiJobPublicId: "job-1", artifact: null, approvedAt: null, failureReason: "PROVIDER_NOT_CONFIGURED: no openai" } });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": p }));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByText(/AI provider for this stage isn't configured/i)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Regenerate brief" })).toBeInTheDocument();
  });

  it("approving the Brief calls the API and adopts the returned read model", async () => {
    const ready = pipeline({ brief: { status: "READY", aiJobPublicId: "job-1", artifact: briefArtifact, approvedAt: null, failureReason: null } });
    const approved = pipeline({ brief: { status: "APPROVED", aiJobPublicId: "job-1", artifact: briefArtifact, approvedAt: "2026-08-28T00:00:00.000Z", failureReason: null }, currentStage: "OUTLINE" });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/brief/approve")) return mockResponse({ data: approved });
      if (url.includes("/score")) return mockResponse({ data: null });
      return mockResponse({ data: ready });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);

    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve brief" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Approve brief" }));
    // the returned read model is adopted: brief is now APPROVED so the approve button disappears
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve brief" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/blog/blog-1/brief/approve"), expect.objectContaining({ method: "POST" }));
  });

  it("renders the Outline hierarchy and the read-only Draft reader", async () => {
    const p = pipeline({
      brief: { status: "APPROVED", aiJobPublicId: "j", artifact: briefArtifact, approvedAt: "x", failureReason: null },
      outline: { status: "APPROVED", aiJobPublicId: "j", artifact: outlineArtifact, approvedAt: "x", failureReason: null },
      draft: { status: "READY", aiJobPublicId: "j", contentVersionPublicId: "v-123456789", artifact: draftArtifact, pendingFinalization: false, failureReason: null },
    });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": p }));
    renderDetail(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText("The Complete Guide to Home EV Charging")).toBeInTheDocument());
    // "Why charge at home" appears in both the outline section list and the draft reader
    expect(screen.getAllByText("Why charge at home").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("Charging at home is the cheapest option.")).toBeInTheDocument();
    expect(screen.getByText(/Inline editing and full version history land in a later phase/i)).toBeInTheDocument();
  });

  it("shows the internal-linking engine-not-available state as a non-error", async () => {
    const p = pipeline({ internalLinking: { status: "COMPLETED", suggestions: [], reason: "engine_not_available", completedAt: "x" } });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": p }));
    renderDetail(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText(/internal-linking engine will be available in a later module/i)).toBeInTheDocument());
  });

  it("renders all six QA checks with pass/fail, explanation and evidence", async () => {
    const p = pipeline({
      qa: {
        status: "COMPLETED",
        completedAt: "x",
        checks: [
          { id: "grammar", label: "Grammar", passed: true, explanation: "No issues.", evidence: [] },
          { id: "readability", label: "Readability", passed: true, explanation: "12 words/sentence.", evidence: [] },
          { id: "structure_headings", label: "Structure", passed: true, explanation: "OK.", evidence: [] },
          { id: "keyword_stuffing", label: "Keyword stuffing", passed: false, explanation: "Too dense.", evidence: ["density 5%"] },
          { id: "duplicate_content", label: "Duplicate", passed: true, explanation: "Unique.", evidence: [] },
          { id: "brand_compliance", label: "Brand", passed: true, explanation: "Vacuous.", evidence: [] },
        ],
      },
    });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": p }));
    renderDetail(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText("Too dense.")).toBeInTheDocument());
    expect(screen.getByText("density 5%")).toBeInTheDocument();
    expect(screen.getAllByText("Pass")).toHaveLength(5);
    expect(screen.getByText("Fail")).toBeInTheDocument();
  });

  it("a BLOG_VIEW user (no SEO_SCORE) sees the full score panel; a user without BLOG_VIEW... cannot reach the page", async () => {
    const p = pipeline({
      qa: { status: "COMPLETED", checks: [], completedAt: "x" },
      scoring: { status: "COMPLETED", contentScorePublicId: "cs-1", overallScore: 82, passThreshold: 70, passed: true, ranAt: "x" },
    });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": scoreFeedback(), "blog-1": p }));
    renderDetail(["BLOG_VIEW"]); // NO SEO_SCORE
    await waitFor(() => expect(screen.getByText("82")).toBeInTheDocument());
    expect(screen.getByText(/This article passes/i)).toBeInTheDocument();
    expect(await screen.findByText("Add more internal context.")).toBeInTheDocument();
    expect(screen.getByLabelText("Blog dimension score")).toBeInTheDocument();
    // cannot RUN the score
    expect(screen.queryByRole("button", { name: /Run content score|Re-score/ })).not.toBeInTheDocument();
  });

  it("below-threshold score shows the blocking message and itemized recommendations", async () => {
    const p = pipeline({
      qa: { status: "COMPLETED", checks: [], completedAt: "x" },
      scoring: { status: "COMPLETED", contentScorePublicId: "cs-1", overallScore: 41, passThreshold: 70, passed: false, ranAt: "x" },
      reviewGatesUnmet: ["content_score_passed"],
    });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": scoreFeedback({ overallScore: 41, passed: false }), "blog-1": p }));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByText(/below the threshold and cannot go to review yet/i)).toBeInTheDocument());
    expect(screen.getByText("Reach the passing content score")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Submit for review" })).toBeDisabled();
  });

  it("Submit for review is enabled only when canSubmitForReview is true", async () => {
    const ready = pipeline({ contentItem: { publicId: "blog-1", title: "T", contentType: "BLOG", status: "IN_PROGRESS" }, canSubmitForReview: true, reviewGatesUnmet: [] });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": scoreFeedback(), "blog-1": ready }));
    renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Submit for review" })).toBeEnabled());
  });

  it("shows Approve/Reject only for BLOG_APPROVE while in REVIEW; Reject needs a comment", async () => {
    const inReview = pipeline({ contentItem: { publicId: "blog-1", title: "T", contentType: "BLOG", status: "REVIEW" }, currentStage: "IN_REVIEW" });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": scoreFeedback(), "blog-1": inReview }));
    const { unmount } = renderDetail(ALL);
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Comment/), "needs work");
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    unmount();

    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": scoreFeedback(), "blog-1": inReview }));
    renderDetail(["BLOG_VIEW", "BLOG_EDIT"]); // no BLOG_APPROVE
    await waitFor(() => expect(screen.getByText(/awaiting review by someone with approval permission/i)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("shows a polished publish-ready state when APPROVED and does not implement publishing", async () => {
    const approved = pipeline({ contentItem: { publicId: "blog-1", title: "T", contentType: "BLOG", status: "APPROVED" }, publishReady: true, currentStage: "PUBLISH_READY" });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": scoreFeedback(), "blog-1": approved }));
    renderDetail(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText(/Publishing to WordPress and other channels is delivered by a later module/i)).toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Review & publish", level: 2 })).toBeInTheDocument();
  });

  it("schedules a poll while a stage is generating and schedules none once every stage is terminal", async () => {
    const generating = pipeline({ brief: { status: "GENERATING", aiJobPublicId: "j", artifact: null, approvedAt: null, failureReason: null } });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": generating }));
    const setTimeoutSpy = jest.spyOn(global, "setTimeout");

    const { unmount } = renderDetail(["BLOG_VIEW"]);
    await screen.findByText(/Generating the brief/i);
    // a follow-up poll is scheduled while the brief is still generating
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === 2500)).toBe(true);
    unmount();
    setTimeoutSpy.mockClear();

    const terminal = pipeline({
      brief: { status: "APPROVED", aiJobPublicId: "j", artifact: briefArtifact, approvedAt: "x", failureReason: null },
      outline: { status: "APPROVED", aiJobPublicId: "j", artifact: outlineArtifact, approvedAt: "x", failureReason: null },
      contentItem: { publicId: "blog-1", title: "T", contentType: "BLOG", status: "IN_PROGRESS" },
    });
    jest.spyOn(global, "fetch").mockImplementation(routeFetch({ "blog-1/score": null, "blog-1": terminal }));
    renderDetail(["BLOG_VIEW"]);
    await waitFor(() => expect(screen.getByText("home ev charging")).toBeInTheDocument());
    expect(setTimeoutSpy.mock.calls.some(([, ms]) => ms === 2500)).toBe(false);
    setTimeoutSpy.mockRestore();
  });
});
