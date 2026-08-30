import { Logger } from "@nestjs/common";
import OpenAI from "openai";
import {
  AzureSpeechTtsProvider,
  FakeImageProvider,
  FakeTtsProvider,
  ImageGenerationProviderRegistryBuilder,
  OpenAiImageProvider,
  TtsProviderRegistryBuilder,
  type ImageGenerationProvider,
  type ImageGenerationProviderRegistry,
  type TtsProvider,
  type TtsProviderRegistry,
  type TtsVoiceDescriptor,
} from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";

const logger = new Logger("MediaProviderClientFactory");

/**
 * Module 7 Phase 7.4 — this worker process's image + TTS provider
 * registries. Mirrors `ai-provider-client-factory.ts` exactly: the one
 * place per process that reads credentials and constructs vendor
 * clients; adapters never read env.
 *
 * Default is the deterministic fake providers (D7 — no real keys needed
 * for Phase 7.4). A real provider is registered only when
 * `MEDIA_IMAGE_PROVIDER` / `MEDIA_TTS_PROVIDER` names it AND its
 * credentials are present. The fake providers stay registered too (under
 * their own ids) so tests always have them.
 */
export function buildImageProviderRegistry(cfg: WorkerConfig["mediaProviders"], aiCfg: WorkerConfig["ai"]): ImageGenerationProviderRegistry {
  const builder = new ImageGenerationProviderRegistryBuilder();
  const providers: ImageGenerationProvider[] = [new FakeImageProvider("success")];

  if (cfg.imageProviderId === "openai") {
    if (aiCfg.openai.apiKey) {
      providers.push(new OpenAiImageProvider(new OpenAI({ apiKey: aiCfg.openai.apiKey }), { model: cfg.openaiImageModel }));
      logger.log(`OpenAI image provider configured (model: ${cfg.openaiImageModel})`);
    } else {
      logger.warn("MEDIA_IMAGE_PROVIDER=openai but OPENAI_API_KEY is not set — falling back to the fake image provider");
    }
  }

  for (const p of providers) builder.register(p);
  return builder.freeze();
}

export function buildTtsProviderRegistry(cfg: WorkerConfig["mediaProviders"], voices: readonly TtsVoiceDescriptor[]): TtsProviderRegistry {
  const builder = new TtsProviderRegistryBuilder();
  const providers: TtsProvider[] = [new FakeTtsProvider("success")];

  if (cfg.ttsProviderId === "azure") {
    if (cfg.azureSpeechKey && cfg.azureSpeechRegion) {
      providers.push(
        new AzureSpeechTtsProvider({
          subscriptionKey: cfg.azureSpeechKey,
          region: cfg.azureSpeechRegion,
          voices,
        }),
      );
      logger.log(`Azure Speech TTS provider configured (region: ${cfg.azureSpeechRegion})`);
    } else {
      logger.warn("MEDIA_TTS_PROVIDER=azure but AZURE_SPEECH_KEY/AZURE_SPEECH_REGION are not set — falling back to the fake TTS provider");
    }
  }

  for (const p of providers) builder.register(p);
  return builder.freeze();
}

/** The provider id the processors should resolve for real work — the configured one when available, else "fake-*". */
export function resolveImageProviderId(registry: ImageGenerationProviderRegistry, cfg: WorkerConfig["mediaProviders"]): string {
  return cfg.imageProviderId !== "fake" && registry.has(cfg.imageProviderId) ? cfg.imageProviderId : "fake-image";
}
export function resolveTtsProviderId(registry: TtsProviderRegistry, cfg: WorkerConfig["mediaProviders"]): string {
  return cfg.ttsProviderId !== "fake" && registry.has(cfg.ttsProviderId) ? cfg.ttsProviderId : "fake-tts";
}
