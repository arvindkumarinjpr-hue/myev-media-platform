import type OpenAI from "openai";
import { OpenAiImageProvider } from "./openai-image-provider";
import { MediaProviderError, MediaProviderErrorCode } from "../media-provider-error";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function client(generate: jest.Mock): OpenAI {
  return { images: { generate } } as unknown as OpenAI;
}

const req = { workspaceId: "w1", correlationId: "c1", prompt: "an EV at sunrise", aspectRatio: "16:9" as const };

describe("OpenAiImageProvider", () => {
  it("maps a base64 gpt-image-1 response into the neutral result (no response_format param)", async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
    const r = await new OpenAiImageProvider(client(generate), { model: "gpt-image-1" }).generate(req);
    expect(generate.mock.calls[0][0]).not.toHaveProperty("response_format");
    expect(generate.mock.calls[0][0].size).toBe("1536x1024");
    expect(r.mimeType).toBe("image/png");
    expect(r.imageBytes.length).toBeGreaterThan(0);
    expect(r.width).toBe(1536);
  });

  it("asks dall-e-3 for b64_json explicitly", async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
    await new OpenAiImageProvider(client(generate), { model: "dall-e-3" }).generate(req);
    expect(generate.mock.calls[0][0].response_format).toBe("b64_json");
  });

  it("requests a transparent background when asked and the model supports it", async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
    await new OpenAiImageProvider(client(generate), { model: "gpt-image-1" }).generate({ ...req, transparentBackground: true });
    expect(generate.mock.calls[0][0].background).toBe("transparent");
  });

  it("treats a URL-only response as MALFORMED_RESPONSE (no server-side URL fetch in this phase)", async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ url: "https://cdn.example/img.png" }] });
    await expect(new OpenAiImageProvider(client(generate), { model: "gpt-image-1" }).generate(req)).rejects.toMatchObject({
      code: MediaProviderErrorCode.MALFORMED_RESPONSE,
    });
  });

  it.each([
    [401, MediaProviderErrorCode.AUTH_CONFIG, false],
    [400, MediaProviderErrorCode.INVALID_REQUEST, false],
    [429, MediaProviderErrorCode.RATE_LIMIT, true],
    [503, MediaProviderErrorCode.PROVIDER_UNAVAILABLE, true],
  ])("normalizes HTTP %s into %s (retryable=%s)", async (status, code, retryable) => {
    const err = Object.assign(new Error("boom"), { status });
    const generate = jest.fn().mockRejectedValue(err);
    await expect(new OpenAiImageProvider(client(generate), { model: "gpt-image-1" }).generate(req)).rejects.toMatchObject({ code, retryable });
  });

  it("never leaks a raw SDK error", async () => {
    const generate = jest.fn().mockRejectedValue(new Error("sk-secret in message"));
    const caught = await new OpenAiImageProvider(client(generate), { model: "gpt-image-1" }).generate(req).catch((e) => e);
    expect(caught).toBeInstanceOf(MediaProviderError);
    expect(caught.messageSafe).not.toContain("sk-secret");
  });

  it("emits costEstimate only when a per-image price is configured", async () => {
    const generate = jest.fn().mockResolvedValue({ data: [{ b64_json: PNG_B64 }] });
    const withPrice = await new OpenAiImageProvider(client(generate), { model: "gpt-image-1", costPerImage: 0.04 }).generate(req);
    expect(withPrice.costEstimate).toBe(0.04);
    const withoutPrice = await new OpenAiImageProvider(client(generate), { model: "gpt-image-1" }).generate(req);
    expect(withoutPrice.costEstimate).toBeUndefined();
  });
});
