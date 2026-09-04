import { PublishingProviderPermanentError, PublishingProviderRetryableError } from "../publishing-provider-error";
import { classifyMetaGraphFailure } from "./meta-graph-client";

describe("classifyMetaGraphFailure", () => {
  it("classifies is_transient:true as retryable regardless of code", () => {
    const err = classifyMetaGraphFailure(200, { error: { code: 999, is_transient: true } }, "op");
    expect(err).toBeInstanceOf(PublishingProviderRetryableError);
    expect(err.errorCode).toBe("META_TRANSIENT_ERROR");
  });

  it("classifies known rate-limit codes as retryable", () => {
    for (const code of [4, 17, 32, 613]) {
      const err = classifyMetaGraphFailure(400, { error: { code } }, "op");
      expect(err).toBeInstanceOf(PublishingProviderRetryableError);
      expect(err.errorCode).toBe("META_RATE_LIMITED");
    }
  });

  it("classifies code 190 (invalid/expired token) as permanent", () => {
    const err = classifyMetaGraphFailure(401, { error: { code: 190 } }, "op");
    expect(err).toBeInstanceOf(PublishingProviderPermanentError);
    expect(err.errorCode).toBe("META_UNAUTHORIZED");
  });

  it("classifies known permission-error codes as permanent", () => {
    const err = classifyMetaGraphFailure(403, { error: { code: 10 } }, "op");
    expect(err).toBeInstanceOf(PublishingProviderPermanentError);
    expect(err.errorCode).toBe("META_INSUFFICIENT_PERMISSION");
  });

  it("falls back to HTTP status when no structured error body is present", () => {
    expect(classifyMetaGraphFailure(500, undefined, "op")).toBeInstanceOf(PublishingProviderRetryableError);
    expect(classifyMetaGraphFailure(429, undefined, "op").errorCode).toBe("META_RATE_LIMITED");
    expect(classifyMetaGraphFailure(400, undefined, "op")).toBeInstanceOf(PublishingProviderPermanentError);
  });

  it("never echoes the raw Graph error message into the thrown error's own message", () => {
    const secretLookingMessage = "leaked-secret-token-abc123";
    const err = classifyMetaGraphFailure(400, { error: { message: secretLookingMessage, code: 1 } }, "op");
    expect(err.message).not.toContain(secretLookingMessage);
  });
});
