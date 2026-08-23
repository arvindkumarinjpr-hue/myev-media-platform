import type { GoogleGenAI } from "@google/genai";
import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIModelCapability, AIProvider } from "../ai-provider.interface";
import type { AIRequest } from "../ai-request";
import type { AIResponse } from "../ai-response";
import { resolveGenerationSettings, type ModelConfig } from "../model-config";
import { parseStructuredOutput } from "../structured-output";

/**
 * Module 3 Phase 3.1 — Gemini adapter (ADR-003). Same injected-client
 * discipline as OpenAIProvider — see that file's doc comment for the
 * full reasoning (applies identically here).
 */
export class GeminiProvider implements AIProvider {
  readonly id = "gemini";

  constructor(
    private readonly client: GoogleGenAI,
    private readonly config: ModelConfig,
  ) {}

  async execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse> {
    const settings = resolveGenerationSettings(this.config, { temperature: request.temperature, maxTokens: request.maxTokens, timeoutMs: request.timeoutMs });
    const startedAt = Date.now();

    let result: Awaited<ReturnType<GoogleGenAI["models"]["generateContent"]>>;
    try {
      result = await this.client.models.generateContent({
        model: this.config.model,
        contents: request.prompt,
        config: {
          temperature: settings.temperature,
          maxOutputTokens: settings.maxTokens,
          ...(request.systemInstructions ? { systemInstruction: request.systemInstructions } : {}),
          ...(request.outputFormat === "json" ? { responseMimeType: "application/json" } : {}),
          abortSignal: signal,
          httpOptions: { timeout: settings.timeoutMs },
        },
      });
    } catch (err) {
      throw mapGeminiError(err, this.id);
    }

    const rawText = result.text ?? "";
    const output = request.outputFormat === "json" && request.structuredOutputSchema ? ((await parseStructuredOutput(rawText, request.structuredOutputSchema, this.id)) as Record<string, unknown>) : rawText;
    const usage = result.usageMetadata;

    return {
      provider: this.id,
      model: this.config.model,
      requestId: result.responseId ?? `gemini-${startedAt}`,
      output,
      usage: {
        tokensIn: usage?.promptTokenCount ?? 0,
        tokensOut: usage?.candidatesTokenCount ?? 0,
        tokensTotal: usage?.totalTokenCount ?? 0,
      },
      executionTimeMs: Date.now() - startedAt,
      finishReason: mapFinishReason(result.candidates?.[0]?.finishReason),
      correlationId: request.correlationId,
    };
  }

  getCapabilities(): AIModelCapability[] {
    return [{ model: this.config.model, capability: "chat" }];
  }
}

function mapFinishReason(reason: string | undefined): AIResponse["finishReason"] {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
      return "content_filter";
    default:
      return "unknown";
  }
}

/** Maps the @google/genai SDK's own error shape to the normalized taxonomy — never rethrows the raw SDK error. */
function mapGeminiError(err: unknown, provider: string): AIProviderError {
  const status = (err as { status?: number })?.status ?? (err as { code?: number })?.code;
  const message = String((err as { message?: string })?.message ?? "");

  if (message.toLowerCase().includes("timeout") || message.toLowerCase().includes("aborted")) {
    return new AIProviderError(AIProviderErrorCode.TIMEOUT, "Gemini request timed out.", provider, { httpStatus: status });
  }
  if (status === 401 || status === 403) {
    return new AIProviderError(AIProviderErrorCode.AUTH_CONFIG, "Gemini rejected the request as unauthenticated/unauthorized.", provider, { httpStatus: status });
  }
  if (status === 429) {
    return new AIProviderError(AIProviderErrorCode.RATE_LIMIT, "Gemini rate limit exceeded.", provider, { httpStatus: status });
  }
  if (status === 400) {
    return new AIProviderError(AIProviderErrorCode.INVALID_REQUEST, "Gemini rejected the request as invalid.", provider, { httpStatus: status });
  }
  if (typeof status === "number" && status >= 500) {
    return new AIProviderError(AIProviderErrorCode.PROVIDER_UNAVAILABLE, "Gemini is currently unavailable.", provider, { httpStatus: status });
  }
  if (message.toLowerCase().includes("network") || message.toLowerCase().includes("fetch failed") || message.toLowerCase().includes("econnreset")) {
    return new AIProviderError(AIProviderErrorCode.TRANSIENT_NETWORK, "Gemini request failed due to a network error.", provider);
  }
  return new AIProviderError(AIProviderErrorCode.UNKNOWN, "Gemini request failed for an unrecognized reason.", provider, { httpStatus: status });
}
