import type Anthropic from "@anthropic-ai/sdk";
import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIModelCapability, AIProvider } from "../ai-provider.interface";
import type { AIRequest } from "../ai-request";
import type { AIResponse } from "../ai-response";
import { resolveGenerationSettings, type ModelConfig } from "../model-config";
import { parseStructuredOutput } from "../structured-output";

/**
 * Module 3 Phase 3.1 — Anthropic (Claude) adapter (ADR-003). Same
 * injected-client discipline as OpenAIProvider — see that file's doc
 * comment for the full reasoning (applies identically here).
 *
 * Claude has no native JSON-mode flag the way OpenAI does — a structured
 * request is asked for via an explicit system instruction plus
 * validated identically on the way out through the same
 * parseStructuredOutput() every adapter uses, keeping the "never accept
 * malformed structured output" guarantee provider-independent rather
 * than relying on any one vendor's own enforcement.
 */
export class AnthropicProvider implements AIProvider {
  readonly id = "anthropic";

  constructor(
    private readonly client: Anthropic,
    private readonly config: ModelConfig,
  ) {}

  async execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const settings = resolveGenerationSettings(this.config, { temperature: request.temperature, maxTokens: request.maxTokens, timeoutMs: request.timeoutMs });
    const startedAt = Date.now();

    const systemInstructions =
      request.outputFormat === "json"
        ? [request.systemInstructions, "Respond with a single valid JSON object and nothing else — no markdown fences, no commentary."].filter(Boolean).join("\n\n")
        : request.systemInstructions;

    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(
        {
          model: this.config.model,
          max_tokens: settings.maxTokens,
          temperature: settings.temperature,
          ...(systemInstructions ? { system: systemInstructions } : {}),
          messages: [{ role: "user", content: request.prompt }],
        },
        { signal, timeout: settings.timeoutMs },
      );
    } catch (err) {
      throw mapAnthropicError(err, this.id);
    }

    const textBlock = message.content.find((block): block is Anthropic.TextBlock => block.type === "text");
    const rawText = textBlock?.text ?? "";
    const output = request.outputFormat === "json" && request.structuredOutputSchema ? ((await parseStructuredOutput(rawText, request.structuredOutputSchema, this.id)) as Record<string, unknown>) : rawText;

    return {
      provider: this.id,
      model: message.model,
      requestId: message.id,
      output,
      usage: {
        tokensIn: message.usage.input_tokens,
        tokensOut: message.usage.output_tokens,
        tokensTotal: message.usage.input_tokens + message.usage.output_tokens,
      },
      executionTimeMs: Date.now() - startedAt,
      finishReason: mapFinishReason(message.stop_reason),
      correlationId: request.correlationId,
    };
  }

  getCapabilities(): AIModelCapability[] {
    return [{ model: this.config.model, capability: "chat" }];
  }
}

function mapFinishReason(reason: string | null): AIResponse["finishReason"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_call";
    default:
      return "unknown";
  }
}

/** Maps the Anthropic SDK's own APIError hierarchy to the normalized taxonomy — never rethrows the raw SDK error. */
function mapAnthropicError(err: unknown, provider: string): AIProviderError {
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;

  if (name === "APIConnectionTimeoutError") {
    return new AIProviderError(AIProviderErrorCode.TIMEOUT, "Anthropic request timed out.", provider, { httpStatus: status });
  }
  if (name === "APIConnectionError") {
    return new AIProviderError(AIProviderErrorCode.TRANSIENT_NETWORK, "Anthropic request failed due to a network error.", provider);
  }
  if (status === 401) {
    return new AIProviderError(AIProviderErrorCode.AUTH_CONFIG, "Anthropic rejected the request as unauthenticated.", provider, { httpStatus: status });
  }
  if (status === 429) {
    const retryAfterSeconds = Number((err as { headers?: Record<string, string> })?.headers?.["retry-after"]) || undefined;
    return new AIProviderError(AIProviderErrorCode.RATE_LIMIT, "Anthropic rate limit exceeded.", provider, { httpStatus: status, retryAfterSeconds });
  }
  if (status === 400 || status === 422) {
    return new AIProviderError(AIProviderErrorCode.INVALID_REQUEST, "Anthropic rejected the request as invalid.", provider, { httpStatus: status });
  }
  if (status !== undefined && status >= 500) {
    return new AIProviderError(AIProviderErrorCode.PROVIDER_UNAVAILABLE, "Anthropic is currently unavailable.", provider, { httpStatus: status });
  }
  return new AIProviderError(AIProviderErrorCode.UNKNOWN, "Anthropic request failed for an unrecognized reason.", provider, { httpStatus: status });
}
