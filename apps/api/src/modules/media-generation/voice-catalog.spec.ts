import { parseVoiceCatalog, VoiceCatalogError } from "./voice-catalog";

describe("parseVoiceCatalog", () => {
  it("falls back to the built-in en-IN / hi-IN default for an empty value", () => {
    const c = parseVoiceCatalog("");
    expect(c.length).toBeGreaterThanOrEqual(2);
    expect(c.some((v) => v.language === "en-IN")).toBe(true);
    expect(c.some((v) => v.language === "hi-IN")).toBe(true);
  });

  it("parses a valid override array", () => {
    const json = JSON.stringify([{ voiceProfileId: "en-in-a", providerVoiceId: "en-IN-ANeural", language: "en-IN", displayName: "A", styles: ["neutral", "newscast"] }]);
    const c = parseVoiceCatalog(json);
    expect(c).toHaveLength(1);
    expect(c[0].providerVoiceId).toBe("en-IN-ANeural");
  });

  it("rejects invalid JSON", () => {
    expect(() => parseVoiceCatalog("{not json")).toThrow(VoiceCatalogError);
  });

  it("rejects an entry missing a required field", () => {
    expect(() => parseVoiceCatalog(JSON.stringify([{ voiceProfileId: "x", language: "en-IN", displayName: "X" }]))).toThrow(/missing a required field/);
  });

  it("rejects a duplicate voiceProfileId", () => {
    const dup = JSON.stringify([
      { voiceProfileId: "x", providerVoiceId: "a", language: "en-IN", displayName: "X" },
      { voiceProfileId: "x", providerVoiceId: "b", language: "hi-IN", displayName: "Y" },
    ]);
    expect(() => parseVoiceCatalog(dup)).toThrow(/duplicate voiceProfileId/);
  });

  it("rejects an unknown style", () => {
    expect(() => parseVoiceCatalog(JSON.stringify([{ voiceProfileId: "x", providerVoiceId: "a", language: "en-IN", displayName: "X", styles: ["operatic"] }]))).toThrow(/unknown style/);
  });

  it("rejects a malformed BCP-47 language", () => {
    expect(() => parseVoiceCatalog(JSON.stringify([{ voiceProfileId: "x", providerVoiceId: "a", language: "english", displayName: "X" }]))).toThrow(/BCP-47/);
  });

  it("rejects an empty array", () => {
    expect(() => parseVoiceCatalog("[]")).toThrow(/non-empty/);
  });
});
