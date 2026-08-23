import "reflect-metadata";
import { IsString } from "class-validator";
import type Anthropic from "@anthropic-ai/sdk";
import { AIProviderErrorCode } from "../ai-provider-error";
import type { AIRequest } from "../ai-request";
import type { ModelConfig } from "../model-config";
import { AnthropicProvider } from "./anthropic-provider";

class SloganDto {
  @IsString()
  slogan!: string;
}

function request(overrides: Partial<AIRequest> = {}): AIRequest {
  return { workspaceId: "ws_1", prompt: "give me a slogan", correlationId: "corr_1", ...overrides };
}

function config(): ModelConfig {
  return { provider: "anthropic", model: "claude-3-5-sonnet-latest", defaults: { temperature: 0.4, maxTokens: 256, timeoutMs: 12_000 } };
}

function mockClient(create: jest.Mock): Anthropic {
  return { messages: { create } } as unknown as Anthropic;
}

class FakeAnthropicError extends Error {
  constructor(
    public readonly status: number,
    public override readonly name: string,
    message = "mock anthropic failure",
  ) {
    super(message);
  }
}

describe("AnthropicProvider", () => {
  it("normalizes a successful message into the common response shape, including token usage", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "msg_123",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "Charge smart. Drive far." }],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "end_turn",
    });
    const provider = new AnthropicProvider(mockClient(create), config());

    const response = await provider.execute(request());

    expect(response).toMatchObject({
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      requestId: "msg_123",
      output: "Charge smart. Drive far.",
      usage: { tokensIn: 10, tokensOut: 5, tokensTotal: 15 },
      finishReason: "stop",
      correlationId: "corr_1",
    });
  });

  it("appends a JSON-mode system instruction when outputFormat is json, since Claude has no native JSON-mode flag", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "msg_456",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: JSON.stringify({ slogan: "Go electric." }) }],
      usage: { input_tokens: 5, output_tokens: 4 },
      stop_reason: "end_turn",
    });
    const provider = new AnthropicProvider(mockClient(create), config());

    const response = await provider.execute(request({ outputFormat: "json", structuredOutputSchema: SloganDto }));

    expect(response.output).toMatchObject({ slogan: "Go electric." });
    const callArgs = create.mock.calls[0][0] as { system?: string };
    expect(callArgs.system).toMatch(/valid JSON object/i);
  });

  it("normalizes a malformed structured-output failure rather than returning unvalidated text", async () => {
    const create = jest.fn().mockResolvedValue({
      id: "msg_789",
      model: "claude-3-5-sonnet-20241022",
      content: [{ type: "text", text: "not json" }],
      usage: { input_tokens: 5, output_tokens: 4 },
      stop_reason: "end_turn",
    });
    const provider = new AnthropicProvider(mockClient(create), config());

    await expect(provider.execute(request({ outputFormat: "json", structuredOutputSchema: SloganDto }))).rejects.toMatchObject({
      code: AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT,
    });
  });

  it("normalizes a 401 SDK error into AUTH_CONFIG, never rethrowing the raw SDK error", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAnthropicError(401, "AuthenticationError", "invalid x-api-key: sk-ant-abc123"));
    const provider = new AnthropicProvider(mockClient(create), config());

    const err = await provider.execute(request()).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: AIProviderErrorCode.AUTH_CONFIG, provider: "anthropic" });
    expect((err as Error).message).not.toContain("sk-ant-abc123");
  });

  it("normalizes a 429 SDK error into RATE_LIMIT", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAnthropicError(429, "RateLimitError"));
    const provider = new AnthropicProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.RATE_LIMIT });
  });

  it("normalizes an APIConnectionTimeoutError into TIMEOUT", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAnthropicError(0, "APIConnectionTimeoutError"));
    const provider = new AnthropicProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TIMEOUT });
  });

  it("normalizes an APIConnectionError into TRANSIENT_NETWORK", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAnthropicError(0, "APIConnectionError"));
    const provider = new AnthropicProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TRANSIENT_NETWORK });
  });

  it("normalizes a 400 SDK error into INVALID_REQUEST", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAnthropicError(400, "InvalidRequestError"));
    const provider = new AnthropicProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.INVALID_REQUEST });
  });

  it("normalizes a 529 SDK error into PROVIDER_UNAVAILABLE", async () => {
    const create = jest.fn().mockRejectedValue(new FakeAnthropicError(529, "OverloadedError"));
    const provider = new AnthropicProvider(mockClient(create), config());
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.PROVIDER_UNAVAILABLE });
  });
});
