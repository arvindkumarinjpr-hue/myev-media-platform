import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { TtsStyleHint } from "@myev/shared";
import type { AppConfig } from "../../config/configuration";

/**
 * Module 7 Phase 7.4 — config-driven Azure voice catalog (D8).
 *
 * The public identity of a voice is the provider-neutral `voiceProfileId`
 * — never the Azure `providerVoiceId`. The catalog is supplied via
 * `VIDEO_VOICE_CATALOG_JSON` (a JSON array) and can be changed without
 * touching domain code; an empty/absent/invalid value falls back to the
 * built-in en-IN / hi-IN default. Exactly one business voice is never
 * hard-coded as "the" voice — every entry is selectable.
 */
export interface VoiceProfile {
  /** Stable, provider-neutral id — the ONLY identity that reaches the API/read model. */
  voiceProfileId: string;
  /** Azure neural voice name — used only by the worker's Azure adapter. */
  providerVoiceId: string;
  /** BCP-47. */
  language: string;
  displayName: string;
  styles: TtsStyleHint[];
}

const VALID_STYLES: readonly TtsStyleHint[] = ["neutral", "newscast", "cheerful", "calm"];

const DEFAULT_CATALOG: VoiceProfile[] = [
  { voiceProfileId: "en-in-neerja", providerVoiceId: "en-IN-NeerjaNeural", language: "en-IN", displayName: "Neerja (Indian English)", styles: ["neutral", "newscast", "cheerful"] },
  { voiceProfileId: "en-in-prabhat", providerVoiceId: "en-IN-PrabhatNeural", language: "en-IN", displayName: "Prabhat (Indian English)", styles: ["neutral"] },
  { voiceProfileId: "hi-in-swara", providerVoiceId: "hi-IN-SwaraNeural", language: "hi-IN", displayName: "Swara (Hindi)", styles: ["neutral", "cheerful"] },
  { voiceProfileId: "hi-in-madhur", providerVoiceId: "hi-IN-MadhurNeural", language: "hi-IN", displayName: "Madhur (Hindi)", styles: ["neutral"] },
];

export class VoiceCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceCatalogError";
  }
}

/** Pure parse+validate — throws `VoiceCatalogError` on any malformed entry. Exported for unit testing. */
export function parseVoiceCatalog(json: string): VoiceProfile[] {
  const trimmed = json.trim();
  if (!trimmed) return [...DEFAULT_CATALOG];
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    throw new VoiceCatalogError("VIDEO_VOICE_CATALOG_JSON is not valid JSON");
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new VoiceCatalogError("voice catalog must be a non-empty JSON array");
  }
  const seen = new Set<string>();
  return raw.map((entry, i) => {
    if (!entry || typeof entry !== "object") throw new VoiceCatalogError(`voice catalog entry ${i} is not an object`);
    const e = entry as Record<string, unknown>;
    const voiceProfileId = String(e.voiceProfileId ?? "").trim();
    const providerVoiceId = String(e.providerVoiceId ?? "").trim();
    const language = String(e.language ?? "").trim();
    const displayName = String(e.displayName ?? "").trim();
    if (!voiceProfileId || !providerVoiceId || !language || !displayName) {
      throw new VoiceCatalogError(`voice catalog entry ${i} is missing a required field`);
    }
    if (!/^[a-z]{2,3}-[A-Za-z]{2,4}$/.test(language)) {
      throw new VoiceCatalogError(`voice catalog entry ${i} has an invalid BCP-47 language "${language}"`);
    }
    if (seen.has(voiceProfileId)) throw new VoiceCatalogError(`duplicate voiceProfileId "${voiceProfileId}"`);
    seen.add(voiceProfileId);
    const styles = Array.isArray(e.styles) ? e.styles.map(String) : ["neutral"];
    for (const s of styles) {
      if (!VALID_STYLES.includes(s as TtsStyleHint)) throw new VoiceCatalogError(`voice catalog entry ${i} has an unknown style "${s}"`);
    }
    return { voiceProfileId, providerVoiceId, language, displayName, styles: styles as TtsStyleHint[] };
  });
}

@Injectable()
export class VoiceCatalogService {
  private readonly logger = new Logger(VoiceCatalogService.name);
  private readonly catalog: VoiceProfile[];

  constructor(config: ConfigService<AppConfig, true>) {
    let parsed: VoiceProfile[];
    try {
      parsed = parseVoiceCatalog(config.get("videoMedia", { infer: true }).voiceCatalogJson);
    } catch (err) {
      this.logger.warn(`Falling back to the default voice catalog: ${(err as Error).message}`);
      parsed = [...DEFAULT_CATALOG];
    }
    this.catalog = parsed;
  }

  list(): VoiceProfile[] {
    // Public view — never leaks providerVoiceId to a caller that only
    // needs the neutral id. Callers that need providerVoiceId (the voice
    // job builder) use `resolve()`.
    return this.catalog.map(({ voiceProfileId, language, displayName, styles }) => ({ voiceProfileId, providerVoiceId: "", language, displayName, styles }));
  }

  /** Returns the full profile (incl. providerVoiceId) or null when the id is not in the catalog. */
  resolve(voiceProfileId: string): VoiceProfile | null {
    return this.catalog.find((v) => v.voiceProfileId === voiceProfileId) ?? null;
  }
}
