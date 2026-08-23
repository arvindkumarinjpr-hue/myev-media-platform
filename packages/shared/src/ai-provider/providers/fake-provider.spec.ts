import "reflect-metadata";
import { IsString } from "class-validator";
import { AIProviderError, AIProviderErrorCode } from "../ai-provider-error";
import type { AIRequest } from "../ai-request";
import { FakeProvider } from "./fake-provider";

class GreetingDto {
  @IsString()
  greeting!: string;
}

function request(overrides: Partial<AIRequest> = {}): AIRequest {
  return { workspaceId: "ws_1", prompt: "hello", correlationId: "corr_1", ...overrides };
}

describe("FakeProvider", () => {
  it("is deterministic across repeated calls with the same mode and input", async () => {
    const provider = new FakeProvider("success");
    const first = await provider.execute(request());
    const second = await provider.execute(request());
    expect(first.output).toBe(second.output);
    expect(first.usage).toEqual(second.usage);
    expect(first.finishReason).toBe(second.finishReason);
  });

  it("echoes the prompt into a deterministic text response in success mode", async () => {
    const provider = new FakeProvider("success");
    const response = await provider.execute(request({ prompt: "write a tagline" }));
    expect(response.output).toBe("fake response to: write a tagline");
    expect(response.provider).toBe("fake");
  });

  it("returns a schema-validated structured object in structured_success mode", async () => {
    const provider = new FakeProvider("structured_success", { greeting: "hi there" });
    const response = await provider.execute(request({ outputFormat: "json", structuredOutputSchema: GreetingDto }));
    expect(response.output).toMatchObject({ greeting: "hi there" });
  });

  it("throws a normalized TRANSIENT_NETWORK error in transient_error mode", async () => {
    const provider = new FakeProvider("transient_error");
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TRANSIENT_NETWORK });
  });

  it("throws a normalized INVALID_REQUEST error in permanent_error mode", async () => {
    const provider = new FakeProvider("permanent_error");
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.INVALID_REQUEST });
  });

  it("throws a normalized TIMEOUT error in timeout mode", async () => {
    const provider = new FakeProvider("timeout");
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.TIMEOUT });
  });

  it("throws a normalized RATE_LIMIT error with retryAfterSeconds metadata in rate_limit mode", async () => {
    const provider = new FakeProvider("rate_limit");
    await expect(provider.execute(request())).rejects.toMatchObject({ code: AIProviderErrorCode.RATE_LIMIT, metadata: { retryAfterSeconds: 1 } });
  });

  it("respects an already-aborted signal regardless of mode", async () => {
    const provider = new FakeProvider("success");
    const controller = new AbortController();
    controller.abort();
    await expect(provider.execute(request(), controller.signal)).rejects.toBeInstanceOf(AIProviderError);
  });

  it("reports its own capabilities without requiring a call to execute()", () => {
    const provider = new FakeProvider();
    expect(provider.getCapabilities()).toEqual([{ model: "fake-model-1", capability: "chat" }]);
  });
});
