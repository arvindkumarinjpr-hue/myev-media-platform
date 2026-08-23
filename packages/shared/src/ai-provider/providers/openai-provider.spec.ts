import "reflect-metadata";
import { IsString } from "class-validator";
import type OpenAI from "openai";
import { AIProviderErrorCode } from "../ai-provider-error";
import type { AIRequest } from "../ai-request";
import type { ModelConfig } from "../model-config";
import { OpenAIProvider } from "./openai-provider";

class SloganDto {
  @IsString()
  slogan!: string;
}

function request(overrides: Partial<AIRequest> = {}): AIRequest {
  return { workspaceId: "ws_1", prompt: "give me a slogan", correlationId: "corr_1", ...overrides };
}

function config(overrides: Partial<ModelConfig["defaults"]> = {}): ModelConfig {
  return { provider: "openai", model: "gpt-4o", defaults: { temperature: 0.5, maxTokens: 512, timeoutMs: 10_000, ...overrides } };
}

function mockClient(create: jest.Mock): OpenAI {
  return { chat: { completions: { create } } } as unknown as OpenAI;
}

class FakeAPIError extends Error {
  constructor(
    public readonly status: number,
    public override readonly name: string,
    message = "mock openai failure",
  ) {
    super(message);
  }
}

describe("OpenAIProvider", () => {
  it("normalizes a successful chat completion into the common response shape, including token usage", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_123",
      model: "gpt-4o-2024-08-06",
      choices: [{ message: { content: "Charge smart. Drive far." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    });
    const provider = new OpenAIProvider(mockClient(create), config());

    const response = await provider.execute(request());

    expect(response).toMatchObject({
      provider: "openai",
      model: "gpt-4o-2024-08-06",
      requestId: "chatcmpl_123",
      output: "Charge smart. Drive far.",
      usage: { tokensIn: 12, tokensOut: 6, tokensTotal: 18 },
      finishReason: "stop",
      correlationId: "corr_1",
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-4o", temperature: 0.5, max_tokens: 512 }),
      expect.objectContaining({ timeout: 10_000 }),
    );
  });

  it("returns a schema-validated structured object when outputFormat is json", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_456",
      model: "gpt-4o",
      choices: [{ message: { content: JSON.stringify({ slogan: "Go electric." }) }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
    const provider = new OpenAIProvider(mockClient(create), config());

    const response = await provider.execute(request({ outputFormat: "json", structuredOutputSchema: SloganDto }));

    expect(response.output).toMatchObject({ slogan: "Go electric." });
  });

  it("normalizes a malformed structured-output failure rather than returning unvalidated text", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_789",
      model: "gpt-4o",
      choices: [{ message: { content: "not json" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 },
    });
    const provider = new OpenAIProvider(mockClient(create), config());

    await expect(provider.execute(request({ outputFormat: "json", structuredOutputSchema: SloganDto }))).rejects.toMatchObject({
      code: AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT,
    });
  });

  it("normalizes a 401 SDK error into AUTH_CONFIG, never rethrowing the raw SDK error", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAPIError(401, "AuthenticationError", "Incorrect API key provided: sk-abc123XYZ"));
    const provider = new OpenAIProvider(mockClient(create), config());

    const err = await provider.execute(request()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: AIProviderErrorCode.AUTH_CONFIG, provider: "openai" });
    expect((err as Error).message).not.toContain("sk-abc123XYZ");
  });

  it("normalizes a 429 SDK error into RATE_LIMIT", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAPIError(429, "RateLimitError"));
    const provider = new OpenAIProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.RATE_LIMIT });
  });

  it("normalizes an APIConnectionTimeoutError into TIMEOUT", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAPIError(0, "APIConnectionTimeoutError"));
    const provider = new OpenAIProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TIMEOUT });
  });

  it("normalizes an APIConnectionError into TRANSIENT_NETWORK", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAPIError(0, "APIConnectionError"));
    const provider = new OpenAIProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TRANSIENT_NETWORK });
  });

  it("normalizes a 400 SDK error into INVALID_REQUEST", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAPIError(400, "BadRequestError"));
    const provider = new OpenAIProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.INVALID_REQUEST });
  });

  it("normalizes a 503 SDK error into PROVIDER_UNAVAILABLE", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAPIError(503, "InternalServerError"));
    const provider = new OpenAIProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.PROVIDER_UNAVAILABLE });
  });

  it("never calls the SDK's own client.chat.completions.create with retry configuration — retry is not this layer's responsibility", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "chatcmpl_1",
      model: "gpt-4o",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    const provider = new OpenAIProvider(mockClient(create), config());
    await provider.execute(request());
    expect(create).toHaveBeenCalledTimes(1);
  });
});
