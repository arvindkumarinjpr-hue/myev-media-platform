import { AIProviderError, AIProviderErrorCode } from "./ai-provider-error";

describe("AIProviderError", () => {
  it.each([
    [AIProviderErrorCode.RATE_LIMIT, true],
    [AIProviderErrorCode.PROVIDER_UNAVAILABLE, true],
    [AIProviderErrorCode.TIMEOUT, true],
    [AIProviderErrorCode.TRANSIENT_NETWORK, true],
    [AIProviderErrorCode.AUTH_CONFIG, false],
    [AIProviderErrorCode.INVALID_REQUEST, false],
    [AIProviderErrorCode.CONTENT_SAFETY_REJECTED, false],
    [AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT, false],
    [AIProviderErrorCode.UNKNOWN, false],
  ])("classifies %s as retryable=%s", (code, expected) => {
    const err = new AIProviderError(code, "safe message", "fake");
    expect(err.retryable).toBe(expected);
  });

  it("never includes the raw metadata object in the thrown message itself", () => {
    const err = new AIProviderError(AIProviderErrorCode.AUTH_CONFIG, "Provider rejected the request as unauthenticated.", "openai", {
      httpStatus: 401,
      providerRequestId: "req_abc123",
    });
    expect(err.message).toBe("Provider rejected the request as unauthenticated.");
    expect(err.messageSafe).toBe(err.message);
  });

  it("carries the provider id and metadata separately from the safe message for structured logging, without ever needing to embed a secret in the message to do so", () => {
    const err = new AIProviderError(AIProviderErrorCode.RATE_LIMIT, "Rate limit exceeded.", "anthropic", { retryAfterSeconds: 30 });
    expect(err.provider).toBe("anthropic");
    expect(err.metadata.retryAfterSeconds).toBe(30);
    expect(err.messageSafe).not.toMatch(/key|token|bearer|secret/i);
  });
});
