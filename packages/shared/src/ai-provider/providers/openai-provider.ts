import type OpenAI from "openai";
import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIModelCapability, AIProvider } from "../ai-provider.interface";
import type { AIRequest } from "../ai-request";
import type { AIResponse } from "../ai-response";
import { resolveGenerationSettings, type ModelConfig } from "../model-config";
import { parseStructuredOutput } from "../structured-output";

/**
 * Module 3 Phase 3.1 — OpenAI adapter (ADR-003: one of the 3 providers
 * the Blueprint commits to at launch). The `OpenAI` client is injected,
 * never constructed here — this module never reads an API key or any
 * other config directly (that happens once, at composition time,
 * wherever the app wires `new OpenAIProvider(new OpenAI({apiKey,
 * maxRetries: 0}), config)`), and it's what makes this adapter testable
 * with a plain mock object instead of mocking the `openai` module
 * itself. `maxRetries: 0` on the injected client is the caller's
 * responsibility — enforced by this adapter never retrying internally
 * either (ADR-005: retry belongs to the future async job layer, not
 * here — compounding SDK-retry + this-layer-retry + a future job-queue
 * retry is exactly the double-retry this phase's own boundary forbids).
 */
export class OpenAIProvider implements AIProvider {
  readonly id = "openai";

  constructor(
    private readonly client: OpenAI,
    private readonly config: ModelConfig,
  ) {}

  async execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const settings = resolveGenerationSettings(this.config, { temperature: request.temperature, maxTokens: request.maxTokens, timeoutMs: request.timeoutMs });
    const startedAt = Date.now();

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (request.systemInstructions) messages.push({ role: "system", content: request.systemInstructions });
    messages.push({ role: "user", content: request.prompt });

    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages,
          temperature: settings.temperature,
          max_tokens: settings.maxTokens,
          ...(request.outputFormat === "json" ? { response_format: { type: "json_object" as const } } : {}),
        },
        { signal, timeout: settings.timeoutMs },
      );
    } catch (err) {
      throw mapOpenAIError(err, this.id);
    }

    const choice = completion.choices[0];
    const rawText = choice?.message?.content ?? "";
    const output = request.outputFormat === "json" && request.structuredOutputSchema ? ((await parseStructuredOutput(rawText, request.structuredOutputSchema, this.id)) as Record<string, unknown>) : rawText;

    return {
      provider: this.id,
      model: completion.model,
      requestId: completion.id,
      output,
      usage: {
        tokensIn: completion.usage?.prompt_tokens ?? 0,
        tokensOut: completion.usage?.completion_tokens ?? 0,
        tokensTotal: completion.usage?.total_tokens ?? 0,
      },
      executionTimeMs: Date.now() - startedAt,
      finishReason: mapFinishReason(choice?.finish_reason),
      correlationId: request.correlationId,
    };
  }

  getCapabilities(): AIModelCapability[] {
    return [{ model: this.config.model, capability: "chat" }];
  }
}

function mapFinishReason(reason: string | null | undefined): AIResponse["finishReason"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "tool_calls":
      return "tool_call";
    default:
      return "unknown";
  }
}

/** Maps the OpenAI SDK's own error shape (APIError subclasses, keyed mainly by HTTP status) to the normalized taxonomy — never rethrows the raw SDK error, never includes headers/body in the safe message. */
function mapOpenAIError(err: unknown, provider: string): AIProviderError {
  const status = (err as { status?: number })?.status;
  const name = (err as { name?: string })?.name;

  if (name === "APIConnectionTimeoutError") {
    return new AIProviderError(AIProviderErrorCode.TIMEOUT, "OpenAI request timed out.", provider, { httpStatus: status });
  }
  if (name === "APIConnectionError") {
    return new AIProviderError(AIProviderErrorCode.TRANSIENT_NETWORK, "OpenAI request failed due to a network error.", provider);
  }
  if (status === 401 || status === 403) {
    return new AIProviderError(AIProviderErrorCode.AUTH_CONFIG, "OpenAI rejected the request as unauthenticated/unauthorized.", provider, { httpStatus: status });
  }
  if (status === 429) {
    const retryAfterSeconds = Number((err as { headers?: Record<string, string> })?.headers?.["retry-after"]) || undefined;
    return new AIProviderError(AIProviderErrorCode.RATE_LIMIT, "OpenAI rate limit exceeded.", provider, { httpStatus: status, retryAfterSeconds });
  }
  if (status === 400 || status === 422) {
    return new AIProviderError(AIProviderErrorCode.INVALID_REQUEST, "OpenAI rejected the request as invalid.", provider, { httpStatus: status });
  }
  if (status !== undefined && status >= 500) {
    return new AIProviderError(AIProviderErrorCode.PROVIDER_UNAVAILABLE, "OpenAI is currently unavailable.", provider, { httpStatus: status });
  }
  return new AIProviderError(AIProviderErrorCode.UNKNOWN, "OpenAI request failed for an unrecognized reason.", provider, { httpStatus: status });
}
