import { Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { AIProviderRegistryBuilder, AnthropicProvider, FakeProvider, GeminiProvider, OpenAIProvider, VideoUatFixtureProvider, type AIProvider, type AIProviderRegistry } from "@myev/shared";
import type { WorkerConfig } from "../config/configuration";

const logger = new Logger("AiProviderClientFactory");

/**
 * Module 3 Phase 3.4 — this worker process's own copy of apps/api's
 * identical factory (see that file's doc comment for the full
 * rationale). A separate copy, not a shared module, for the same reason
 * every other per-process registry wiring in this codebase is
 * duplicated rather than shared: apps/api and apps/worker are separate
 * NestJS processes that never import each other's compiled providers.
 *
 * `@google/genai` publishes itself as `"type": "module"` (pure ESM,
 * unlike `openai`/`@anthropic-ai/sdk`, both plain CommonJS) — this
 * process compiles with `"module": "commonjs"` (standard tsc output), so
 * a static `import { GoogleGenAI } from "@google/genai"` compiles to a
 * `require()` that throws `ReferenceError: require is not defined in ES
 * module scope` the instant this module loads, regardless of whether
 * Gemini is even configured. A plain `await import(...)` doesn't fix
 * this either — under `"module": "commonjs"`, TypeScript itself
 * downlevels dynamic `import()` to `Promise.resolve().then(() =>
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
export async function buildProductionProviders(ai: WorkerConfig["ai"]): Promise<AIProvider[]> {
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
 * Assembles this worker process's real AIProviderRegistry — same
 * production-providers-plus-env-gated-FakeProvider shape as apps/api's
 * identical function, extracted the same way so the env gate is
 * directly unit testable without NestJS DI. FakeProvider and the Phase
 * 3.3 test fixtures (fake-flaky/fake-permanent/fake-timeout) register
 * only when `env !== "production"`.
 */
export async function buildAiProviderRegistry(ai: WorkerConfig["ai"], env: string): Promise<AIProviderRegistry> {
  const builder = new AIProviderRegistryBuilder();
  for (const provider of await buildProductionProviders(ai)) {
    builder.register(provider);
  }
  if (env !== "production") {
    builder.register(new FakeProvider("structured_success", { echo: "test-echo-agent-default-response" }));
    builder.register(new FakeProvider("flaky_then_success", {}, 1, "fake-flaky"));
    builder.register(new FakeProvider("permanent_error", {}, 1, "fake-permanent"));
    builder.register(new FakeProvider("timeout", {}, 1, "fake-timeout"));
    // Module 7 Phase 7.7 closure — the deterministic Video-agent fixture,
    // registered under the "openai" id every Video agent prefers, so a
    // full Video pipeline can run on a staging/UAT env with no external
    // AI keys (for the mandatory real-Remotion-render staging UAT). Doubly
    // gated: this `env !== "production"` block AND no real OPENAI_API_KEY,
    // so it can never shadow a configured provider and cannot exist in
    // production.
    if (!ai.openai.apiKey) {
      builder.register(new VideoUatFixtureProvider("openai"));
      logger.warn('Video UAT fixture provider registered under "openai" (env !== production, no OPENAI_API_KEY) — Video agents will return deterministic fixture output');
    }
  }
  return builder.freeze();
}
