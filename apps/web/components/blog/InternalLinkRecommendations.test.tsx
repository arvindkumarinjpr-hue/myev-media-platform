import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InternalLinkRecommendations } from "./InternalLinkRecommendations";
import { mockResponse } from "../../lib/test-mock-response";
import type { InternalLinkRecommendation } from "../../lib/types";

function recommendation(overrides: Partial<InternalLinkRecommendation> = {}): InternalLinkRecommendation {
  return {
    publicId: "il-1",
    sourceContentItemPublicId: "blog-1",
    targetContentItemPublicId: "blog-2",
    targetTitle: "EV Charging Costs Explained",
    anchorText: "EV charging costs",
    relevanceScore: 82,
    status: "GENERATED",
    evidence: {
      overallScore: 82,
      totalWeight: 12,
      factors: [{ id: "cluster-match", label: "Cluster match", reason: "Both articles share a topic cluster.", normalizedScore: 90, weight: 4, contribution: 360 }],
      discoveryMethod: "cluster",
      anchor: { source: "target-primary-keyword", selectedAnchor: "EV charging costs" },
    },
    reason: "Same content series / topic cluster (relevance 82)",
    generatedAt: "2026-08-01T00:00:00.000Z",
    reviewedAt: null,
    reviewedByPublicId: null,
    rejectionReason: null,
    staleReason: null,
    ...overrides,
  };
}

function listFetch(rows: InternalLinkRecommendation[]) {
  return jest.fn(async () => mockResponse({ data: rows }));
}

function renderList(rows: InternalLinkRecommendation[], canEdit: boolean) {
  jest.spyOn(global, "fetch").mockImplementation(listFetch(rows));
  return render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit={canEdit} />);
}

describe("InternalLinkRecommendations", () => {
  afterEach(() => jest.restoreAllMocks());

  it("shows a loading state, then the populated list under the default (Needs review) filter", async () => {
    renderList([recommendation()], true);
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("EV Charging Costs Explained")).toBeInTheDocument());
    const row = screen.getByText("EV Charging Costs Explained").closest("li") as HTMLElement;
    expect(within(row).getByText("Needs review")).toBeInTheDocument();
    expect(screen.getByText(/EV charging costs/)).toBeInTheDocument();
    expect(screen.getByRole("meter", { name: "Relevance score" })).toHaveAttribute("aria-valuenow", "82");
  });

  it("shows the empty state when there are no recommendations yet", async () => {
    renderList([], true);
    await waitFor(() => expect(screen.getByText("No internal-link recommendations yet.")).toBeInTheDocument());
  });

  it("filters by status and shows a per-filter empty message", async () => {
    renderList([recommendation({ publicId: "il-1", status: "GENERATED" }), recommendation({ publicId: "il-2", status: "ACCEPTED", targetTitle: "Battery Swap Stations" })], true);
    await waitFor(() => expect(screen.getByText("EV Charging Costs Explained")).toBeInTheDocument());
    expect(screen.queryByText("Battery Swap Stations")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /Rejected/ }));
    expect(screen.getByText(/No rejected recommendations\./i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("tab", { name: /Accepted/ }));
    expect(screen.getByText("Battery Swap Stations")).toBeInTheDocument();
  });

  it("expands the evidence disclosure to show structured, non-JSON factors", async () => {
    renderList([recommendation()], true);
    await waitFor(() => expect(screen.getByText("EV Charging Costs Explained")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Why this recommendation?"));
    expect(screen.getByText(/Both articles share a topic cluster\./)).toBeInTheDocument();
    expect(screen.getByText(/The target's primary keyword/)).toBeInTheDocument();
  });

  it("hides Generate and every mutation control without canEdit", async () => {
    renderList([recommendation()], false);
    await waitFor(() => expect(screen.getByText("EV Charging Costs Explained")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Generate recommendations" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit anchor" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("shows Generate and mutation controls with canEdit for a GENERATED row", async () => {
    renderList([recommendation()], true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate recommendations" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Edit anchor" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument();
  });

  it("does not offer Edit anchor for a non-GENERATED row even with canEdit", async () => {
    renderList([recommendation({ status: "ACCEPTED", reviewedAt: "2026-08-02T00:00:00.000Z" })], true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate recommendations" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: /Accepted/ }));
    expect(screen.getByText("EV Charging Costs Explained")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit anchor" })).not.toBeInTheDocument();
  });

  it("generate: adopts the returned list and calls the generate endpoint", async () => {
    const generated = [recommendation({ publicId: "il-2", targetTitle: "New Suggestion" })];
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/internal-links/generate")) return mockResponse({ data: generated });
      return mockResponse({ data: [] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit />);

    await waitFor(() => expect(screen.getByText("No internal-link recommendations yet.")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate recommendations" }));
    await waitFor(() => expect(screen.getByText("New Suggestion")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("blog/blog-1/internal-links/generate"), expect.objectContaining({ method: "POST" }));
  });

  it("generate: a zero-result response shows the valid-empty-result message", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/generate")) return mockResponse({ data: [] });
      return mockResponse({ data: [] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Generate recommendations" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate recommendations" }));
    await waitFor(() => expect(screen.getByText("No relevant approved Blog targets were found.")).toBeInTheDocument());
  });

  it("generate: a typed backend error is surfaced without crashing", async () => {
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/generate")) return mockResponse({ code: "BLOG_SEO_NOT_READY", message: "The SEO pass must complete first." }, 422);
      return mockResponse({ data: [] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Generate recommendations" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Generate recommendations" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The SEO pass must complete first."));
  });

  it("anchor edit: save calls PATCH and adopts the new anchor text; cancel discards the draft", async () => {
    const updated = { publicId: "il-1", anchorText: "cheapest home charging", relevanceScore: 82, status: "GENERATED" as const, reviewedAt: null, rejectionReason: null, staleReason: null };
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "PATCH" && url.includes("/internal-links/il-1")) return mockResponse({ data: updated });
      return mockResponse({ data: [recommendation()] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Edit anchor" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Edit anchor" }));
    const input = screen.getByLabelText("Anchor text");
    await userEvent.clear(input);
    await userEvent.type(input, "cheapest home charging");
    await userEvent.click(screen.getByRole("button", { name: "Save anchor" }));
    await waitFor(() => expect(screen.getByText(/cheapest home charging/)).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/internal-links/il-1"), expect.objectContaining({ method: "PATCH", body: JSON.stringify({ anchorText: "cheapest home charging" }) }));
  });

  it("anchor edit: Save is disabled for an empty draft, and the input caps input at 60 characters", async () => {
    renderList([recommendation()], true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit anchor" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Edit anchor" }));
    const input = screen.getByLabelText("Anchor text");
    expect(input).toHaveAttribute("maxlength", "60");
    await userEvent.clear(input);
    expect(screen.getByRole("button", { name: "Save anchor" })).toBeDisabled();
    // The native maxLength attribute enforces the backend's own 60-char limit client-side — typing past it is a no-op.
    await userEvent.type(input, "x".repeat(70));
    expect(input).toHaveValue("x".repeat(60));
    expect(screen.getByRole("button", { name: "Save anchor" })).toBeEnabled();
  });

  it("accept: adopts ACCEPTED status and removes mutation controls", async () => {
    const accepted = { publicId: "il-1", anchorText: "EV charging costs", relevanceScore: 82, status: "ACCEPTED" as const, reviewedAt: "2026-08-02T00:00:00.000Z", rejectionReason: null, staleReason: null };
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/accept")) return mockResponse({ data: accepted });
      return mockResponse({ data: [recommendation()] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/internal-links/il-1/accept"), expect.objectContaining({ method: "POST" }));

    // The row is refreshed, not lost: it now lives under the Accepted filter with no mutation controls.
    await userEvent.click(screen.getByRole("tab", { name: /Accepted/ }));
    expect(screen.getByText("EV Charging Costs Explained")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("reject: requires a reason, supports cancel, and keeps rejected rows visible under the Rejected filter", async () => {
    const rejected = { publicId: "il-1", anchorText: "EV charging costs", relevanceScore: 82, status: "REJECTED" as const, reviewedAt: "2026-08-02T00:00:00.000Z", rejectionReason: "Not relevant enough.", staleReason: null };
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (init?.method === "POST" && url.includes("/reject")) return mockResponse({ data: rejected });
      return mockResponse({ data: [recommendation()] });
    });
    jest.spyOn(global, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
    render(<InternalLinkRecommendations workspaceId="ws-1" itemId="blog-1" canEdit />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Reject" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    const submit = screen.getByRole("button", { name: "Reject" });
    expect(submit).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Rejection reason")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Reject" }));
    await userEvent.type(screen.getByLabelText("Rejection reason"), "Not relevant enough.");
    await userEvent.click(screen.getByRole("button", { name: "Reject" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/internal-links/il-1/reject"), expect.objectContaining({ method: "POST", body: JSON.stringify({ rejectionReason: "Not relevant enough." }) })));
    await userEvent.click(screen.getByRole("tab", { name: /Rejected/ }));
    expect(within(screen.getByRole("tabpanel", { name: /Rejected/ })).getByText("EV Charging Costs Explained")).toBeInTheDocument();
    expect(screen.getByText(/Rejection reason: Not relevant enough\./)).toBeInTheDocument();
  });

  it("shows STALE rows as non-actionable with their stale reason", async () => {
    renderList([recommendation({ status: "STALE", staleReason: "target no longer eligible (read-time safety check)" })], true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate recommendations" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: /Stale/ }));
    const row = screen.getByText("EV Charging Costs Explained").closest("li") as HTMLElement;
    expect(within(row).getByText("Stale")).toBeInTheDocument();
    expect(screen.getByText("target no longer eligible (read-time safety check)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit anchor" })).not.toBeInTheDocument();
  });
});
