import "reflect-metadata";
import { IsString } from "class-validator";
import type { GoogleGenAI } from "@google/genai";
import { AIProviderErrorCode } from "../ai-provider-error";
import type { AIRequest } from "../ai-request";
import type { ModelConfig } from "../model-config";
import { GeminiProvider } from "./gemini-provider";

class SloganDto {
  @IsString()
  slogan!: string;
}

function request(overrides: Partial<AIRequest> = {}): AIRequest {
  return { workspaceId: "ws_1", prompt: "give me a slogan", correlationId: "corr_1", ...overrides };
}

function config(): ModelConfig {
  return { provider: "gemini", model: "gemini-1.5-pro", defaults: { temperature: 0.6, maxTokens: 1024, timeoutMs: 20_000 } };
}

function mockClient(generateContent: jest.Mock): GoogleGenAI {
  return { models: { generateContent } } as unknown as GoogleGenAI;
}

class FakeGeminiError extends Error {
  constructor(
    public readonly status: number,
    message = "mock gemini failure",
  ) {
    super(message);
  }
}

describe("GeminiProvider", () => {
  it("normalizes a successful generation into the common response shape, including token usage", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      responseId: "resp_123",
      text: "Charge smart. Drive far.",
      usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 4, totalTokenCount: 12 },
      candidates: [{ finishReason: "STOP" }],
    });
    const provider = new GeminiProvider(mockClient(generateContent), config());

    const response = await provider.execute(request());

    expect(response).toMatchObject({
      provider: "gemini",
      model: "gemini-1.5-pro",
      requestId: "resp_123",
      output: "Charge smart. Drive far.",
      usage: { tokensIn: 8, tokensOut: 4, tokensTotal: 12 },
      finishReason: "stop",
      correlationId: "corr_1",
    });
  });

  it("returns a schema-validated structured object when outputFormat is json", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      responseId: "resp_456",
      text: JSON.stringify({ slogan: "Go electric." }),
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      candidates: [{ finishReason: "STOP" }],
    });
    const provider = new GeminiProvider(mockClient(generateContent), config());

    const response = await provider.execute(request({ outputFormat: "json", structuredOutputSchema: SloganDto }));

    expect(response.output).toMatchObject({ slogan: "Go electric." });
  });

  it("normalizes a malformed structured-output failure rather than returning unvalidated text", async () => {
    const generateContent = jest.fn().mockResolvedValue({
      responseId: "resp_789",
      text: "not json",
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 4, totalTokenCount: 9 },
      candidates: [{ finishReason: "STOP" }],
    });
    const provider = new GeminiProvider(mockClient(generateContent), config());

    await expect(provider.execute(request({ outputFormat: "json", structuredOutputSchema: SloganDto }))).rejects.toMatchObject({
      code: AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT,
    });
  });

  it("normalizes a 401/403 SDK error into AUTH_CONFIG, never rethrowing the raw SDK error", async () => {
    const generateContent = jest.fn().mockRejectedValue(new FakeGeminiError(403, "API key not valid: AIzaSyABC123secret"));
    const provider = new GeminiProvider(mockClient(generateContent), config());

    const err = await provider.execute(request()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: AIProviderErrorCode.AUTH_CONFIG, provider: "gemini" });
    expect((err as Error).message).not.toContain("AIzaSyABC123secret");
  });

  it("normalizes a 429 SDK error into RATE_LIMIT", async () => {
    const generateContent = jest.fn().mockRejectedValue(new FakeGeminiError(429));
    const provider = new GeminiProvider(mockClient(generateContent), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.RATE_LIMIT });
  });

  it("normalizes a timeout-flavored message into TIMEOUT", async () => {
    const generateContent = jest.fn().mockRejectedValue(new Error("Request timeout exceeded"));
    const provider = new GeminiProvider(mockClient(generateContent), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TIMEOUT });
  });

  it("normalizes a network-flavored message into TRANSIENT_NETWORK", async () => {
    const generateContent = jest.fn().mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    const provider = new GeminiProvider(mockClient(generateContent), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TRANSIENT_NETWORK });
  });

  it("normalizes a 400 SDK error into INVALID_REQUEST", async () => {
    const generateContent = jest.fn().mockRejectedValue(new FakeGeminiError(400));
    const provider = new GeminiProvider(mockClient(generateContent), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.INVALID_REQUEST });
  });

  it("normalizes a 500 SDK error into PROVIDER_UNAVAILABLE", async () => {
    const generateContent = jest.fn().mockRejectedValue(new FakeGeminiError(500));
    const provider = new GeminiProvider(mockClient(generateContent), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.PROVIDER_UNAVAILABLE });
  });
});
