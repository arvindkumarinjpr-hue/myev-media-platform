import type { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { ContentItemsService } from "./content-items.service";
import type { AppConfig } from "../../config/configuration";

/**
 * Narrow, targeted unit test for validateAndNormalizeComment — the one
 * private helper on this service with no Prisma dependency (pure logic
 * over an injected ConfigService), same category as ContentBodyValidator.
 * Everything else on ContentItemsService is Prisma-heavy and covered by
 * the e2e suite instead (content-items.e2e-spec.ts), per this codebase's
 * established split.
 *
 * Regression coverage for a real defect found during the pre-PR
 * verification pass: submit/approve previously trimmed a comment without
 * re-validating its length against the *configured* limit — only reject()
 * did. An operator lowering CONTENT_REVIEW_COMMENT_MAX_LENGTH below the
 * DTO layer's hardcoded 2000-char ceiling would have had that stricter
 * limit silently unenforced for submit/approve. All three now share one
 * validated code path.
 */
function makeService(reviewCommentMaxLength: number): ContentItemsService {
  const content: AppConfig["content"] = {
    maxBodySizeBytes: 2_000_000,
    maxBodyDepth: 10,
    maxStringValueLength: 200_000,
    base64HeuristicMinLength: 512,
    reviewCommentMaxLength,
  };
  const config = { get: () => content } as unknown as ConfigService<AppConfig, true>;
  // Only ConfigService is exercised by validateAndNormalizeComment — the
  // other 4 constructor dependencies are never touched by this method.
  return new ContentItemsService(undefined as never, undefined as never, undefined as never, undefined as never, config);
}

function validateAndNormalizeComment(service: ContentItemsService, comment: string | undefined, options: { required: boolean }): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (service as any).validateAndNormalizeComment(comment, options);
}

describe("ContentItemsService.validateAndNormalizeComment", () => {
  it("enforces the CONFIGURED limit, not just the DTO's hardcoded 2000-char ceiling", () => {
    const service = makeService(50);
    expect(() => validateAndNormalizeComment(service, "x".repeat(51), { required: false })).toThrow(BadRequestException);
    expect(validateAndNormalizeComment(service, "x".repeat(50), { required: false })).toBe("x".repeat(50));
  });

  it("accepts an optional comment up to the configured limit for submit/approve (required: false)", () => {
    const service = makeService(2000);
    expect(validateAndNormalizeComment(service, undefined, { required: false })).toBeNull();
    expect(validateAndNormalizeComment(service, "   ", { required: false })).toBeNull();
    expect(validateAndNormalizeComment(service, "looks good", { required: false })).toBe("looks good");
  });

  it("requires a non-blank comment for reject (required: true)", () => {
    const service = makeService(2000);
    expect(() => validateAndNormalizeComment(service, undefined, { required: true })).toThrow(BadRequestException);
    expect(() => validateAndNormalizeComment(service, "   ", { required: true })).toThrow(BadRequestException);
    expect(validateAndNormalizeComment(service, "  needs work  ", { required: true })).toBe("needs work");
  });

  it("rejects a too-long required comment with CONTENT_REVIEW_COMMENT_TOO_LONG, not the required-comment code", () => {
    const service = makeService(10);
    expect(() => validateAndNormalizeComment(service, "x".repeat(11), { required: true })).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ code: "CONTENT_REVIEW_COMMENT_TOO_LONG" }) }),
    );
  });
});
