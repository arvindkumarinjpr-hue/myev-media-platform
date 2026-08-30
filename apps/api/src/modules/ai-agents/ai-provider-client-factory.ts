import { Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AIProviderRegistryBuilder, AnthropicProvider, FakeProvider, GeminiProvider, OpenAIProvider, VideoUatFixtureProvider, type AIProvider, type AIProviderRegistry } from "@myev/shared";
import type { AppConfig } from "../../config/configuration";

const logger = new Logger("AiProviderClientFactory");

/**
 * Module 3 Phase 3.4 — constructs the real vendor SDK clients and wraps
 * them in Phase 3.1's own adapters, per Phase 3.1's injected-client
 * discipline (the adapters themselves never read env/secrets — this is
 * the one place, per process, that does). A provider whose apiKey is
 * empty is skipped entirely, not registered with an invalid client —
 * calling it later resolves cleanly through AIProviderRegistry.resolve's
 * existing "unknown provider" error rather than failing inside a real
 * SDK call with a confusing auth error.
 *
 * `@google/genai` publishes itself as `"type": "module"` (pure ESM,
 * unlike `openai`/`@anthropic-ai/sdk`, both plain CommonJS) — this
 * process compiles with `"module": "commonjs"` (standard NestJS/tsc
 * output), so a static `import { GoogleGenAI } from "@google/genai"`
 * compiles to a `require()` that throws `ReferenceError: require is not
 * defined in ES module scope` the instant this module loads, regardless
 * of whether Gemini is even configured. A plain `await import(...)`
 * doesn't fix this either — under `"module": "commonjs"`, TypeScript
 * itself downlevels dynamic `import()` to `Promise.resolve().then(() =>
 * require(...))`, the very same crash. `importGoogleGenAI()` below uses
 * the standard workaround for this exact CJS-loads-ESM pitfall: building
 * the `import()` call from a string via the Function constructor keeps
 * it invisible to TypeScript's static transform, so Node's own runtime
 * still sees (and correctly handles) a real dynamic import.
 */
async function importGoogleGenAI(): Promise<typeof import("@google/genai")> {
  const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<typeof import("@google/genai")>;
  return dynamicImport("@google/genai");
}
export async function buildProductionProviders(ai: AppConfig["ai"]): Promise<AIProvider[]> {
  const providers: AIProvider[] = [];

  if (ai.openai.apiKey) {
    providers.push(new OpenAIProvider(new OpenAI({ apiKey: ai.openai.apiKey }), { provider: "openai", model: ai.openai.model, defaults: {} }));
    logger.log(`OpenAI provider configured (model: ${ai.openai.model})`);
  } else {
    logger.warn("OpenAI provider not configured — OPENAI_API_KEY is not set");
  }

  if (ai.anthropic.apiKey) {
    providers.push(new AnthropicProvider(new Anthropic({ apiKey: ai.anthropic.apiKey }), { provider: "anthropic", model: ai.anthropic.model, defaults: {} }));
    logger.log(`Anthropic provider configured (model: ${ai.anthropic.model})`);
  } else {
    logger.warn("Anthropic provider not configured — ANTHROPIC_API_KEY is not set");
  }

  if (ai.gemini.apiKey) {
    const { GoogleGenAI } = await importGoogleGenAI();
    providers.push(new GeminiProvider(new GoogleGenAI({ apiKey: ai.gemini.apiKey }), { provider: "gemini", model: ai.gemini.model, defaults: {} }));
    logger.log(`Gemini provider configured (model: ${ai.gemini.model})`);
  } else {
    logger.warn("Gemini provider not configured — GEMINI_API_KEY is not set");
  }

  return providers;
}

/**
 * Assembles the process's real AIProviderRegistry: production providers
 * (always attempted, per-provider skip on missing credentials) plus
 * FakeProvider — but only when `env !== "production"`. Extracted as a
 * plain function (no NestJS DI) so this env-gating is directly unit
 * testable — see this file's own .spec.ts, "never registers FakeProvider
 * when env is production" regression proof.
 */
export async function buildAiProviderRegistry(ai: AppConfig["ai"], env: string): Promise<AIProviderRegistry> {
  const builder = new AIProviderRegistryBuilder();
  for (const provider of await buildProductionProviders(ai)) {
    builder.register(provider);
  }
  if (env !== "production") {
    builder.register(new FakeProvider("structured_success", { echo: "test-echo-agent-default-response" }));
    // Module 7 Phase 7.7 closure — mirror apps/worker's factory (this
    // codebase keeps the two identical): the deterministic Video-agent
    // fixture under the "openai" id, doubly gated (env !== "production"
    // AND no real OPENAI_API_KEY) so it cannot shadow a configured
    // provider and cannot exist in production.
    if (!ai.openai.apiKey) {
      builder.register(new VideoUatFixtureProvider("openai"));
    }
  }
  return builder.freeze();
}
