import { readWorkerCoreConfig, WorkerConfigError, type WorkerCoreConfig } from "@myev/worker-core";

export { WorkerConfigError };

/**
 * The dedicated render / media worker's configuration = the shared
 * `WorkerCoreConfig` (@myev/worker-core — DB/Redis/queues/heartbeat/
 * shutdown/reconciliation + object storage + media size limits) plus
 * this process's own keys: the image/TTS provider selection, the voice
 * catalog seed, and the render engine.
 *
 * This is the ONLY process that consumes the MEDIA queue — image, voice,
 * subtitle generation AND video rendering (frozen "MEDIA = dedicated
 * isolated workers"). It owns Remotion and every heavy render dependency;
 * `apps/worker` (general SYSTEM/AI) has none of it.
 */
export interface WorkerConfig extends WorkerCoreConfig {
  ai: {
    openai: { apiKey: string; model: string };
    anthropic: { apiKey: string; model: string };
    gemini: { apiKey: string; model: string };
  };
  mediaProviders: {
    imageProviderId: string; // "fake" | "openai"
    openaiImageModel: string;
    ttsProviderId: string; // "fake" | "azure"
    azureSpeechKey: string;
    azureSpeechRegion: string;
  };
  videoMedia: {
    voiceCatalogJson: string;
  };
  render: {
    /** "remotion" (production default) or "deterministic-test" (test-only). */
    engine: string;
    engineVersion: string;
    /** Root for per-job isolated temp directories (checkpoint §28). Empty → OS tmp. */
    tempDir: string;
    /** Hard ceiling on a produced render file. */
    maxOutputBytes: number;
    /** Optional system Chromium path for the Remotion engine. */
    chromiumExecutablePath: string;
    /** Optional explicit Remotion composition entry (defaults to the bundled sources). */
    remotionEntry: string;
  };
}

export default function configuration(): WorkerConfig {
  const core = readWorkerCoreConfig();
  return {
    ...core,
    ai: {
      openai: { apiKey: process.env.OPENAI_API_KEY ?? "", model: process.env.OPENAI_MODEL ?? "gpt-4o" },
      anthropic: { apiKey: process.env.ANTHROPIC_API_KEY ?? "", model: process.env.ANTHROPIC_MODEL ?? "claude-3-5-sonnet-20241022" },
      gemini: { apiKey: process.env.GEMINI_API_KEY ?? "", model: process.env.GEMINI_MODEL ?? "gemini-1.5-pro" },
    },
    mediaProviders: {
      imageProviderId: process.env.MEDIA_IMAGE_PROVIDER ?? "fake",
      openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
      ttsProviderId: process.env.MEDIA_TTS_PROVIDER ?? "fake",
      azureSpeechKey: process.env.AZURE_SPEECH_KEY ?? "",
      azureSpeechRegion: process.env.AZURE_SPEECH_REGION ?? "",
    },
    videoMedia: {
      voiceCatalogJson: process.env.VIDEO_VOICE_CATALOG_JSON ?? "",
    },
    render: {
      // Production/default is the real Remotion engine. The deterministic
      // engine is TEST-ONLY (fast coverage; no Chromium/FFmpeg).
      engine: process.env.RENDER_ENGINE ?? "remotion",
      engineVersion: process.env.RENDER_ENGINE_VERSION ?? process.env.WORKER_APPLICATION_VERSION ?? "0.1.0",
      tempDir: process.env.RENDER_TEMP_DIR ?? "",
      maxOutputBytes: parseInt(process.env.RENDER_MAX_OUTPUT_BYTES ?? "2147483648", 10),
      chromiumExecutablePath: process.env.RENDER_CHROMIUM_PATH ?? "",
      remotionEntry: process.env.REMOTION_ENTRY ?? "",
    },
  };
}
