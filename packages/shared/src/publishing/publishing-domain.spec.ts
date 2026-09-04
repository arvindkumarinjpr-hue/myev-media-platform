import { assertContentPublishEligible, assertPublicationTargetTransition, derivePublicationSummary, isPublicationTargetLive } from "./publishing-domain";

describe("assertContentPublishEligible", () => {
  it("passes for an APPROVED, non-deleted Blog", () => {
    expect(() => assertContentPublishEligible({ contentType: "BLOG", status: "APPROVED", deletedAt: null })).not.toThrow();
  });

  it.each(["DRAFT", "IN_PROGRESS", "REVIEW", "ARCHIVED", "DELETED", "RENDERING", "FAILED", "SCHEDULED", "PUBLISHED"] as const)("rejects a Blog with status %s", (status) => {
    expect(() => assertContentPublishEligible({ contentType: "BLOG", status, deletedAt: null })).toThrow();
  });

  it("rejects an otherwise-eligible Blog once deletedAt is set", () => {
    expect(() => assertContentPublishEligible({ contentType: "BLOG", status: "APPROVED", deletedAt: new Date() })).toThrow();
  });

  it("passes for an APPROVED Video with a COMPLETED render job", () => {
    expect(() => assertContentPublishEligible({ contentType: "VIDEO", status: "APPROVED", deletedAt: null, latestVideoRenderJobStatus: "COMPLETED" })).not.toThrow();
  });

  it.each(["QUEUED", "RUNNING", "FAILED", "TIMED_OUT", null, undefined] as const)("rejects an APPROVED Video whose latest render job is %s", (renderStatus) => {
    expect(() => assertContentPublishEligible({ contentType: "VIDEO", status: "APPROVED", deletedAt: null, latestVideoRenderJobStatus: renderStatus })).toThrow(/render/i);
  });

  it("rejects a non-APPROVED Video even with a COMPLETED render job (approval is checked first)", () => {
    expect(() => assertContentPublishEligible({ contentType: "VIDEO", status: "REVIEW", deletedAt: null, latestVideoRenderJobStatus: "COMPLETED" })).toThrow();
  });

  it("never requires a render-job status for a Blog (the field is VIDEO-only context)", () => {
    expect(() => assertContentPublishEligible({ contentType: "BLOG", status: "APPROVED", deletedAt: null, latestVideoRenderJobStatus: null })).not.toThrow();
  });
});

describe("assertPublicationTargetTransition", () => {
  const valid: Array<[string, string]> = [
    ["PENDING", "SCHEDULED"],
    ["PENDING", "QUEUED"],
    ["PENDING", "CANCELLED"],
    ["SCHEDULED", "QUEUED"],
    ["SCHEDULED", "CANCELLED"],
    ["QUEUED", "PUBLISHING"],
    ["QUEUED", "CANCELLED"],
    ["PUBLISHING", "PUBLISHED"],
    ["PUBLISHING", "FAILED"],
    ["FAILED", "QUEUED"],
    ["FAILED", "CANCELLED"],
  ];
  it.each(valid)("allows %s -> %s", (from, to) => {
    expect(() => assertPublicationTargetTransition(from as never, to as never)).not.toThrow();
  });

  it("never allows FAILED -> PENDING (a silent reset would erase real attempt history)", () => {
    expect(() => assertPublicationTargetTransition("FAILED", "PENDING")).toThrow();
  });

  it.each(["PUBLISHED", "CANCELLED"] as const)("rejects every transition out of the terminal state %s", (from) => {
    for (const to of ["PENDING", "SCHEDULED", "QUEUED", "PUBLISHING", "PUBLISHED", "FAILED", "CANCELLED"] as const) {
      if (to === from) continue;
      expect(() => assertPublicationTargetTransition(from, to)).toThrow();
    }
  });

  it("rejects a backward transition (e.g. QUEUED -> PENDING)", () => {
    expect(() => assertPublicationTargetTransition("QUEUED", "PENDING")).toThrow();
  });

  it("rejects skipping straight to PUBLISHED without ever being PUBLISHING", () => {
    expect(() => assertPublicationTargetTransition("PENDING", "PUBLISHED")).toThrow();
    expect(() => assertPublicationTargetTransition("QUEUED", "PUBLISHED")).toThrow();
  });
});

describe("isPublicationTargetLive", () => {
  it.each(["PENDING", "SCHEDULED", "QUEUED", "PUBLISHING"] as const)("treats %s as live", (status) => {
    expect(isPublicationTargetLive(status)).toBe(true);
  });

  it.each(["PUBLISHED", "FAILED", "CANCELLED"] as const)("treats %s as not live (history)", (status) => {
    expect(isPublicationTargetLive(status)).toBe(false);
  });
});

describe("derivePublicationSummary", () => {
  it("reports fully published only when every target published", () => {
    const summary = derivePublicationSummary(["PUBLISHED", "PUBLISHED"]);
    expect(summary.isFullyPublished).toBe(true);
    expect(summary.hasPartialFailure).toBe(false);
    expect(summary.isFullyTerminal).toBe(true);
  });

  it("never collapses a mixed published/failed result into isFullyPublished", () => {
    const summary = derivePublicationSummary(["PUBLISHED", "FAILED"]);
    expect(summary.isFullyPublished).toBe(false);
    expect(summary.hasPartialFailure).toBe(true);
    expect(summary.isFullyTerminal).toBe(true);
    expect(summary.publishedCount).toBe(1);
    expect(summary.failedCount).toBe(1);
  });

  it("reports not-yet-terminal while any target is still live", () => {
    const summary = derivePublicationSummary(["PUBLISHED", "QUEUED"]);
    expect(summary.isFullyTerminal).toBe(false);
    expect(summary.liveCount).toBe(1);
  });

  it("reports empty/zero-target state truthfully (never fully published with zero targets)", () => {
    const summary = derivePublicationSummary([]);
    expect(summary.totalTargets).toBe(0);
    expect(summary.isFullyPublished).toBe(false);
    expect(summary.isFullyTerminal).toBe(true);
  });

  it("a cancelled-only Publication is terminal, not published, not a partial failure", () => {
    const summary = derivePublicationSummary(["CANCELLED", "CANCELLED"]);
    expect(summary.isFullyPublished).toBe(false);
    expect(summary.hasPartialFailure).toBe(false);
    expect(summary.isFullyTerminal).toBe(true);
    expect(summary.cancelledCount).toBe(2);
  });
});
