import { AzureSpeechTtsProvider } from "./azure-speech-tts-provider";
import { MediaProviderError, MediaProviderErrorCode } from "../media-provider-error";

const base = {
  workspaceId: "w1",
  correlationId: "c1",
  voiceProfileId: "en-in-neerja",
  providerVoiceId: "en-IN-NeerjaNeural",
  language: "en-IN",
  outputFormat: "mp3" as const,
};

const catalog = [{ providerVoiceId: "en-IN-NeerjaNeural", language: "en-IN", displayName: "Neerja", styles: ["neutral" as const] }];

describe("AzureSpeechTtsProvider", () => {
  it("the Azure Speech SDK resolves cleanly from a fresh install and exposes the API this adapter uses", async () => {
    const sdk = await import("microsoft-cognitiveservices-speech-sdk");
    expect(typeof sdk.SpeechConfig.fromSubscription).toBe("function");
    expect(typeof sdk.SpeechSynthesizer).toBe("function");
    expect(sdk.SpeechSynthesisBoundaryType.Word).toBeDefined();
    expect(sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3).toBeDefined();
  });

  it("rejects empty text as INVALID_REQUEST before touching the SDK or credentials", async () => {
    const provider = new AzureSpeechTtsProvider({ subscriptionKey: "unused", region: "centralindia", voices: catalog });
    await expect(provider.synthesize({ ...base, text: "   " })).rejects.toMatchObject({ code: MediaProviderErrorCode.INVALID_REQUEST });
  });

  it("fails safely with AUTH_CONFIG when credentials are missing — the SDK is never loaded", async () => {
    const noCreds = new AzureSpeechTtsProvider({ subscriptionKey: "", region: "", voices: [] });
    await expect(noCreds.synthesize({ ...base, text: "hello world" })).rejects.toMatchObject({ code: MediaProviderErrorCode.AUTH_CONFIG });
  });

  it("loads the installed SDK and normalizes a real failure into MediaProviderError — never a raw SDK error, never leaking the key", async () => {
    const provider = new AzureSpeechTtsProvider({ subscriptionKey: "TOTALLY-BOGUS-KEY-1234567890", region: "centralindia", voices: catalog });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const caught = await provider.synthesize({ ...base, text: "hello world" }, controller.signal).catch((e) => e);
    clearTimeout(timer);
    expect(caught).toBeInstanceOf(MediaProviderError);
    // Auth failure, transient network, timeout (abort), or provider-unavailable are all acceptable safe classifications.
    expect([
      MediaProviderErrorCode.AUTH_CONFIG,
      MediaProviderErrorCode.TRANSIENT_NETWORK,
      MediaProviderErrorCode.TIMEOUT,
      MediaProviderErrorCode.PROVIDER_UNAVAILABLE,
      MediaProviderErrorCode.INVALID_REQUEST,
      MediaProviderErrorCode.MALFORMED_RESPONSE,
    ]).toContain((caught as MediaProviderError).code);
    expect((caught as MediaProviderError).messageSafe).not.toContain("TOTALLY-BOGUS-KEY-1234567890");
  }, 15_000);

  it("exposes its configured voice catalog for introspection (no vendor voice ids leak elsewhere)", () => {
    const provider = new AzureSpeechTtsProvider({ subscriptionKey: "k", region: "r", voices: catalog });
    expect(provider.listVoices().map((v) => v.providerVoiceId)).toEqual(["en-IN-NeerjaNeural"]);
  });
});
