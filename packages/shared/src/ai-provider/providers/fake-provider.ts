import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIModelCapability, AIProvider } from "../ai-provider.interface";
import type { AIRequest } from "../ai-request";
import type { AIResponse } from "../ai-response";
import { parseStructuredOutput } from "../structured-output";

export type FakeProviderMode = "success" | "structured_success" | "transient_error" | "permanent_error" | "timeout" | "rate_limit" | "flaky_then_success";

/**
 * Module 3 Phase 3.1 — a deterministic fake AIProvider for unit/E2E
 * usage, with zero AI spend and zero network dependency. Mode is set per
 * instance (construct a new FakeProvider per test scenario) so behavior
 * is fully predictable — this exists specifically so the future Agent
 * Framework's own tests (Phase 3.2+) never need real provider calls or
 * real API keys to be deterministic.
 */
export class FakeProvider implements AIProvider {
  readonly id: string;

  // Stateful across calls on this one instance, deliberately — a real
  // durable-dispatch caller (Module 3 Phase 3.3) reuses the SAME
  // long-lived provider instance across BullMQ retry attempts within one
  // worker process, so this genuinely proves "transient failure, then
  // retry, then eventual success on the same durable job" rather than
  // always-fails-until-exhausted ("transient_error" mode's own behavior).
  private callCount = 0;

  constructor(
    private readonly mode: FakeProviderMode = "success",
    private readonly structuredPayload: Record<string, unknown> = {},
    private readonly failuresBeforeSuccess = 1,
    // Defaults to "fake" — every existing call site that never passed a
    // 4th argument keeps registering under the exact same id as before.
    // Only a caller registering MULTIPLE FakeProvider instances in one
    // registry (Module 3 Phase 3.3's own durable-retry/permanent-failure/
    // timeout test fixtures — AIProviderRegistryBuilder rejects a
    // duplicate id) needs to pass a distinct one.
    id = "fake",
  ) {
    this.id = id;
  }

  async execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    if (signal?.aborted) {
      throw new AIProviderError(AIProviderErrorCode.TIMEOUT, "Request was aborted before the fake provider could respond.", this.id);
    }

    if (this.mode === "flaky_then_success") {
      this.callCount += 1;
      if (this.callCount <= this.failuresBeforeSuccess) {
        throw new AIProviderError(AIProviderErrorCode.TRANSIENT_NETWORK, `Fake provider: simulated transient failure (attempt ${this.callCount}/${this.failuresBeforeSuccess}).`, this.id);
      }
      // Falls through to the same success-path construction below.
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
