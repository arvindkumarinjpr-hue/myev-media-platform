import { assertSocialSourceEligible, SocialDomainError, SOCIAL_DOMAIN_ERRORS, type SocialSourceCandidate } from "./social-domain";

const WS = "ws-1";

function candidate(overrides: Partial<SocialSourceCandidate> = {}): SocialSourceCandidate {
  return { contentType: "BLOG", status: "APPROVED", deletedAt: null, workspaceId: WS, ...overrides };
}

describe("assertSocialSourceEligible", () => {
  it("accepts an Approved Blog in the same workspace", () => {
    expect(() => assertSocialSourceEligible(candidate({ contentType: "BLOG" }), WS)).not.toThrow();
  });

  it("accepts an Approved Video in the same workspace", () => {
    expect(() => assertSocialSourceEligible(candidate({ contentType: "VIDEO" }), WS)).not.toThrow();
  });

  it("rejects a DRAFT source", () => {
    expect(() => assertSocialSourceEligible(candidate({ status: "DRAFT" }), WS)).toThrow(SocialDomainError);
  });

  it("rejects an IN_PROGRESS source", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ status: "IN_PROGRESS" }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_NOT_APPROVED);
  });

  it("rejects a REVIEW source", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ status: "REVIEW" }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_NOT_APPROVED);
  });

  it("rejects an ARCHIVED source", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ status: "ARCHIVED" }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_NOT_APPROVED);
  });

  it("rejects a DELETED source by status even if deletedAt were somehow still null", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ status: "DELETED" }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_NOT_APPROVED);
  });

  it("rejects a soft-deleted source (deletedAt set) even if status is still APPROVED", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ status: "APPROVED", deletedAt: new Date() }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_DELETED);
  });

  it("rejects a SOCIAL_POST as a source, even if Approved — no chained repurposing in v1", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ contentType: "SOCIAL_POST", status: "APPROVED" }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_CONTENT_TYPE_UNSUPPORTED);
  });

  it.each(["SHORT", "REEL", "NEWSLETTER"])("rejects the still-reserved content type %s as a source", (contentType) => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ contentType, status: "APPROVED" }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_CONTENT_TYPE_UNSUPPORTED);
  });

  it("rejects a source from a different workspace, before checking anything else about it", () => {
    const err = catchError(() => assertSocialSourceEligible(candidate({ workspaceId: "ws-other", status: "DRAFT", deletedAt: new Date() }), WS));
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_WORKSPACE_MISMATCH);
  });

  it("checks workspace before deletion before content type before status — workspace mismatch wins even for an otherwise-invalid candidate", () => {
    const err = catchError(() =>
      assertSocialSourceEligible(candidate({ workspaceId: "ws-other", contentType: "SOCIAL_POST", status: "DRAFT", deletedAt: new Date() }), WS),
    );
    expect(err.code).toBe(SOCIAL_DOMAIN_ERRORS.SOCIAL_SOURCE_WORKSPACE_MISMATCH);
  });
});

function catchError(fn: () => void): SocialDomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SocialDomainError) return error;
    throw error;
  }
  throw new Error("expected fn to throw a SocialDomainError");
}
