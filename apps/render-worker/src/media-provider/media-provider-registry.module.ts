import { Global, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { ImageGenerationProviderRegistry, TtsProviderRegistry, TtsVoiceDescriptor } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";
import { buildImageProviderRegistry, buildTtsProviderRegistry } from "./media-provider-client-factory";

export const IMAGE_PROVIDER_REGISTRY = Symbol("IMAGE_PROVIDER_REGISTRY");
export const TTS_PROVIDER_REGISTRY = Symbol("TTS_PROVIDER_REGISTRY");

/**
 * Module 7 Phase 7.4 — the worker process's image + TTS provider
 * registries, built and frozen once at DI construction time (same
 * @Global/useFactory/freeze-once pattern as AiProviderRegistryModule).
 *
 * The Azure adapter's voice catalog for `listVoices()` introspection is
 * seeded from `VIDEO_VOICE_CATALOG_JSON` if present, else a small default
 * — the API's `VoiceCatalogService` is the authority for validation, this
 * is only the worker-side descriptor list.
 */
function workerVoiceDescriptors(): TtsVoiceDescriptor[] {
  const raw = process.env.VIDEO_VOICE_CATALOG_JSON;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Array<Record<string, unknown>>;
      return parsed.map((v) => ({
        providerVoiceId: String(v.providerVoiceId ?? ""),
        language: String(v.language ?? "en-IN"),
        displayName: String(v.displayName ?? ""),
        styles: Array.isArray(v.styles) ? (v.styles as TtsVoiceDescriptor["styles"]) : ["neutral"],
      }));
    } catch {
      /* fall through */
    }
  }
  return [
    { providerVoiceId: "en-IN-NeerjaNeural", language: "en-IN", displayName: "Neerja", styles: ["neutral", "newscast", "cheerful"] },
    { providerVoiceId: "hi-IN-SwaraNeural", language: "hi-IN", displayName: "Swara", styles: ["neutral", "cheerful"] },
  ];
}

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: IMAGE_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerConfig, true>): ImageGenerationProviderRegistry =>
        buildImageProviderRegistry(config.get("mediaProviders", { infer: true }), config.get("ai", { infer: true })),
    },
    {
      provide: TTS_PROVIDER_REGISTRY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<WorkerConfig, true>): TtsProviderRegistry =>
        buildTtsProviderRegistry(config.get("mediaProviders", { infer: true }), workerVoiceDescriptors()),
    },
  ],
  exports: [IMAGE_PROVIDER_REGISTRY, TTS_PROVIDER_REGISTRY],
})
export class MediaProviderRegistryModule {}
