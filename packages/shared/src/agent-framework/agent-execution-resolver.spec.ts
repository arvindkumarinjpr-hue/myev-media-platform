import "reflect-metadata";
import { AIProviderRegistryBuilder } from "../ai-provider/ai-provider-registry";
import { AnthropicProvider } from "../ai-provider/providers/anthropic-provider";
import { FakeProvider } from "../ai-provider/providers/fake-provider";
import { GeminiProvider } from "../ai-provider/providers/gemini-provider";
import { OpenAIProvider } from "../ai-provider/providers/openai-provider";
import type { AgentDefinition } from "./agent-definition";
import { AgentExecutionErrorCode } from "./agent-execution-error";
import { AgentExecutionResolutionError, resolveAgentExecution } from "./agent-execution-resolver";
import { TEST_ECHO_AGENT_V1 } from "./test-agent";

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...TEST_ECHO_AGENT_V1, ...overrides };
}

describe("resolveAgentExecution", () => {
  it("resolves the exact registered provider and model for a fake-provider agent", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();

    const result = resolveAgentExecution(TEST_ECHO_AGENT_V1, registry);
    expect(result.provider.id).toBe("fake");
    expect(result.model).toBe("fake-model-1");
  });

  it("resolves a production-style OpenAIProvider through the registry", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new OpenAIProvider({} as never, { provider: "openai", model: "gpt-4o", defaults: {} }));
    const registry = builder.freeze();

    const result = resolveAgentExecution(definition({ providerPreference: { provider: "openai", model: "gpt-4o" } }), registry);
    expect(result.provider.id).toBe("openai");
    expect(result.model).toBe("gpt-4o");
  });

  it("resolves a production-style AnthropicProvider through the registry", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new AnthropicProvider({} as never, { provider: "anthropic", model: "claude-3-5-sonnet-20241022", defaults: {} }));
    const registry = builder.freeze();

    const result = resolveAgentExecution(definition({ providerPreference: { provider: "anthropic", model: "claude-3-5-sonnet-20241022" } }), registry);
    expect(result.provider.id).toBe("anthropic");
    expect(result.model).toBe("claude-3-5-sonnet-20241022");
  });

  it("resolves a production-style GeminiProvider through the registry", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new GeminiProvider({} as never, { provider: "gemini", model: "gemini-1.5-pro", defaults: {} }));
    const registry = builder.freeze();

    const result = resolveAgentExecution(definition({ providerPreference: { provider: "gemini", model: "gemini-1.5-pro" } }), registry);
    expect(result.provider.id).toBe("gemini");
    expect(result.model).toBe("gemini-1.5-pro");
  });

  it("rejects an agent whose required provider is not registered — a clean, classified error, never an uncaught exception", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();

    const unconfigured = definition({ providerPreference: { provider: "openai", model: "gpt-4o" } });
    expect(() => resolveAgentExecution(unconfigured, registry)).toThrow(AgentExecutionResolutionError);
    try {
      resolveAgentExecution(unconfigured, registry);
      fail("expected resolveAgentExecution to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AgentExecutionResolutionError);
      expect((err as AgentExecutionResolutionError).failure.code).toBe(AgentExecutionErrorCode.PROVIDER_NOT_CONFIGURED);
      expect((err as AgentExecutionResolutionError).failure.messageSafe).not.toContain("undefined");
    }
  });

  it("leaves generationSettings empty when neither the agent nor the caller declares any", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();

    const result = resolveAgentExecution(TEST_ECHO_AGENT_V1, registry);
    expect(result.generationSettings).toEqual({});
  });

  it("uses the agent's own declared generationDefaults when the caller supplies no overrides", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();

    const withDefaults = definition({ executionPolicy: { maxAttempts: 1, generationDefaults: { temperature: 0.2, maxTokens: 512 } } });
    const result = resolveAgentExecution(withDefaults, registry);
    expect(result.generationSettings).toEqual({ temperature: 0.2, maxTokens: 512 });
  });

  it("caller-supplied overrides win field-by-field over the agent's own generationDefaults", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();

    const withDefaults = definition({ executionPolicy: { maxAttempts: 1, generationDefaults: { temperature: 0.2, maxTokens: 512, timeoutMs: 10_000 } } });
    const result = resolveAgentExecution(withDefaults, registry, { temperature: 0.9 });
    expect(result.generationSettings).toEqual({ temperature: 0.9, maxTokens: 512, timeoutMs: 10_000 });
  });

  it("never mutates the agent's own declared generationDefaults object across repeated calls with different overrides", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();

    const generationDefaults = { temperature: 0.2 };
    const withDefaults = definition({ executionPolicy: { maxAttempts: 1, generationDefaults } });
    resolveAgentExecution(withDefaults, registry, { temperature: 0.9 });
    expect(generationDefaults).toEqual({ temperature: 0.2 });
  });
});
