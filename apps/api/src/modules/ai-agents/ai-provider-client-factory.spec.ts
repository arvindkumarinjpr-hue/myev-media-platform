import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { buildAiProviderRegistry, buildProductionProviders } from "./ai-provider-client-factory";
import type { AppConfig } from "../../config/configuration";

function ai(overrides: Partial<AppConfig["ai"]> = {}): AppConfig["ai"] {
  return {
    openai: { apiKey: "", model: "gpt-4o" },
    anthropic: { apiKey: "", model: "claude-3-5-sonnet-20241022" },
    gemini: { apiKey: "", model: "gemini-1.5-pro" },
    ...overrides,
  };
}

describe("buildProductionProviders", () => {
  it("registers no providers when no credentials are configured", async () => {
    expect(await buildProductionProviders(ai())).toHaveLength(0);
  });

  it("constructs a real OpenAIProvider when OPENAI_API_KEY is set", async () => {
    const providers = await buildProductionProviders(ai({ openai: { apiKey: "sk-test-key", model: "gpt-4o" } }));
    expect(providers.map((p) => p.id)).toEqual(["openai"]);
  });

  it("constructs a real AnthropicProvider when ANTHROPIC_API_KEY is set", async () => {
    const providers = await buildProductionProviders(ai({ anthropic: { apiKey: "sk-ant-test-key", model: "claude-3-5-sonnet-20241022" } }));
    expect(providers.map((p) => p.id)).toEqual(["anthropic"]);
  });

  // Gemini's own construction path is deliberately NOT exercised here.
  // importGoogleGenAI() uses a Function-constructor dynamic import
  // specifically so a real (non-Jest) Node process can load the
  // ESM-only @google/genai package from this CommonJS one (see that
  // function's own doc comment) — but Jest's default CJS vm sandbox
  // rejects a genuine dynamic import() with "requires
  // --experimental-vm-modules", a Jest/Node interop limit unrelated to
  // whether the production code itself is correct. Verified instead by
  // actually booting apps/api and apps/worker with GEMINI_API_KEY set —
  // see this PR's own description for that manual verification, and
  // the "no providers configured" test above for proof the gemini
  // branch is otherwise correctly skipped when unconfigured.
  it("constructs openai and anthropic together when both credentials are set (gemini omitted — see comment above)", async () => {
    const providers = await buildProductionProviders(
      ai({
        openai: { apiKey: "sk-test-key", model: "gpt-4o" },
        anthropic: { apiKey: "sk-ant-test-key", model: "claude-3-5-sonnet-20241022" },
      }),
    );
    expect(providers.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
  });

  it("never logs the raw API key — only the model name — while constructing a provider", async () => {
    const logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation();
    const warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    try {
      await buildProductionProviders(ai({ openai: { apiKey: "sk-super-secret-value", model: "gpt-4o" } }));
      const allLoggedArgs = [...logSpy.mock.calls, ...warnSpy.mock.calls].flat().map(String);
      expect(allLoggedArgs.some((arg) => arg.includes("sk-super-secret-value"))).toBe(false);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe("buildAiProviderRegistry", () => {
  it("never registers FakeProvider when env is production, even with zero real providers configured", async () => {
    const registry = await buildAiProviderRegistry(ai(), "production");
    expect(registry.has("fake")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it("registers FakeProvider outside production so existing dev/CI test agents keep working", async () => {
    const registry = await buildAiProviderRegistry(ai(), "development");
    expect(registry.has("fake")).toBe(true);
  });

  it("registers real configured providers even in production, alongside no FakeProvider", async () => {
    const registry = await buildAiProviderRegistry(ai({ openai: { apiKey: "sk-test-key", model: "gpt-4o" } }), "production");
    expect(registry.has("openai")).toBe(true);
    expect(registry.has("fake")).toBe(false);
  });

  it("an unconfigured provider fails clearly via the registry's own unknown-provider error, not a crash", async () => {
    const registry = await buildAiProviderRegistry(ai(), "production");
    expect(() => registry.resolve("openai")).toThrow(/unknown provider/i);
  });
});
