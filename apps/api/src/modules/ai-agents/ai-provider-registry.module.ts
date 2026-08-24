import { Global, Module } from "@nestjs/common";
import { AIProviderRegistryBuilder, FakeProvider, type AIProviderRegistry } from "@myev/shared";

export const AI_PROVIDER_REGISTRY = Symbol("AI_PROVIDER_REGISTRY");

/**
 * Module 3 Phase 3.2's own AIProviderRegistry, mirroring
 * QueueRegistryModule's exact @Global/useFactory/freeze-once pattern
 * (apps/api/src/modules/background-jobs/queue-registry.module.ts).
 *
 * Only FakeProvider is registered — the one agent this phase defines
 * (TEST_ECHO_AGENT_V1) only ever calls "fake" (Part 17's own "Use
 * FakeProvider. No live OpenAI/Anthropic/Gemini network calls in CI").
 * Wiring a real OpenAIProvider/AnthropicProvider/GeminiProvider requires
 * an injected vendor SDK client built from a real API key (Phase 3.1's
 * own injected-client discipline — this module never reads a secret
 * itself) — deliberately deferred to whichever future phase adds the
 * first real business agent that actually needs one, rather than wiring
 * unused credentials now.
 */
@Global()
@Module({
  providers: [
    {
      provide: AI_PROVIDER_REGISTRY,
      useFactory: (): AIProviderRegistry => {
        const builder = new AIProviderRegistryBuilder();
        // "structured_success" — not the default "success" — because
        // TEST_ECHO_AGENT_V1 declares an outputSchema: this is the mode
        // that actually calls Phase 3.1's parseStructuredOutput
        // internally, honoring outputFormat/structuredOutputSchema the
        // same way a real adapter would.
        builder.register(new FakeProvider("structured_success", { echo: "test-echo-agent-default-response" }));
        return builder.freeze();
      },
    },
  ],
  exports: [AI_PROVIDER_REGISTRY],
})
export class AiProviderRegistryModule {}
