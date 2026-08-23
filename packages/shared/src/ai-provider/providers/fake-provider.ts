import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIModelCapability, AIProvider } from "../ai-provider.interface";
import type { AIRequest } from "../ai-request";
import type { AIResponse } from "../ai-response";
import { parseStructuredOutput } from "../structured-output";

export type FakeProviderMode = "success" | "structured_success" | "transient_error" | "permanent_error" | "timeout" | "rate_limit";

/**
 * Module 3 Phase 3.1 — a deterministic fake AIProvider for unit/E2E
 * usage, with zero AI spend and zero network dependency. Mode is set per
 * instance (construct a new FakeProvider per test scenario) so behavior
 * is fully predictable — this exists specifically so the future Agent
 * Framework's own tests (Phase 3.2+) never need real provider calls or
 * real API keys to be deterministic.
 */
export class FakeProvider implements AIProvider {
  readonly id = "fake";

  constructor(
    private readonly mode: FakeProviderMode = "success",
    private readonly structuredPayload: Record<string, unknown> = {},
  ) {}

  async execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    if (signal?.aborted) {
      throw new AIProviderError(AIProviderErrorCode.TIMEOUT, "Request was aborted before the fake provider could respond.", this.id);
    }

    switch (this.mode) {
      case "transient_error":
        throw new AIProviderError(AIProviderErrorCode.TRANSIENT_NETWORK, "Fake provider: simulated transient network failure.", this.id);
      case "permanent_error":
        throw new AIProviderError(AIProviderErrorCode.INVALID_REQUEST, "Fake provider: simulated permanent invalid-request failure.", this.id);
      case "timeout":
        throw new AIProviderError(AIProviderErrorCode.TIMEOUT, "Fake provider: simulated timeout.", this.id);
      case "rate_limit":
        throw new AIProviderError(AIProviderErrorCode.RATE_LIMIT, "Fake provider: simulated rate limit.", this.id, { retryAfterSeconds: 1 });
    }

    const usage = { tokensIn: 10, tokensOut: 20, tokensTotal: 30 };
    const base: Omit<AIResponse, "output"> = {
      provider: this.id,
      model: "fake-model-1",
      requestId: `fake-${request.correlationId ?? "no-correlation-id"}`,
      usage,
      executionTimeMs: 1,
      finishReason: "stop",
      correlationId: request.correlationId,
    };

    if (this.mode === "structured_success") {
      const rawText = JSON.stringify(this.structuredPayload);
      const output = request.structuredOutputSchema ? ((await parseStructuredOutput(rawText, request.structuredOutputSchema, this.id)) as Record<string, unknown>) : this.structuredPayload;
      return { ...base, output };
    }

    return { ...base, output: `fake response to: ${request.prompt}` };
  }

  getCapabilities(): AIModelCapability[] {
    return [{ model: "fake-model-1", capability: "chat" }];
  }
}
