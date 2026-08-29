import { AzureSpeechTtsProvider } from "./azure-speech-tts-provider";
import { MediaProviderErrorCode } from "../media-provider-error";

const base = {
  workspaceId: "w1",
  correlationId: "c1",
  voiceProfileId: "en-in-neerja",
  providerVoiceId: "en-IN-NeerjaNeural",
  language: "en-IN",
  outputFormat: "mp3" as const,
};

describe("AzureSpeechTtsProvider (guards — SDK not bundled in Phase 7.4)", () => {
  const provider = new AzureSpeechTtsProvider({ subscriptionKey: "k", region: "centralindia", voices: [{ providerVoiceId: "en-IN-NeerjaNeural", language: "en-IN", displayName: "Neerja", styles: ["neutral"] }] });

  it("rejects empty text as INVALID_REQUEST before touching the SDK", async () => {
    await expect(provider.synthesize({ ...base, text: "   " })).rejects.toMatchObject({ code: MediaProviderErrorCode.INVALID_REQUEST });
  });

  it("rejects when credentials are missing as AUTH_CONFIG", async () => {
    const noCreds = new AzureSpeechTtsProvider({ subscriptionKey: "", region: "", voices: [] });
    await expect(noCreds.synthesize({ ...base, text: "hello" })).rejects.toMatchObject({ code: MediaProviderErrorCode.AUTH_CONFIG });
  });

  it("surfaces a clean AUTH_CONFIG error when the Azure SDK is not installed", async () => {
    await expect(provider.synthesize({ ...base, text: "hello world" })).rejects.toMatchObject({
      code: MediaProviderErrorCode.AUTH_CONFIG,
      messageSafe: expect.stringContaining("Azure Speech SDK is not available"),
    });
  });

  it("exposes its configured voice catalog for introspection", () => {
    expect(provider.listVoices().map((v) => v.providerVoiceId)).toEqual(["en-IN-NeerjaNeural"]);
  });
});
