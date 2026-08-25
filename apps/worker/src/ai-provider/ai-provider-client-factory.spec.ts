import "reflect-metadata";
import { buildAiProviderRegistry, buildProductionProviders } from "./ai-provider-client-factory";
import type { WorkerConfig } from "../config/configuration";

function ai(overrides: Partial<WorkerConfig["ai"]> = {}): WorkerConfig["ai"] {
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

  // Gemini's own construction path is deliberately NOT exercised here —
  // see apps/api's identical spec file for the full explanation (Jest's
  // CJS vm sandbox rejects a genuine dynamic import() without
  // --experimental-vm-modules; verified instead by actually booting
  // this process with GEMINI_API_KEY set).
  it("constructs openai and anthropic together when both credentials are set (gemini omitted — see comment above)", async () => {
    const providers = await buildProductionProviders(
      ai({
        openai: { apiKey: "sk-test-key", model: "gpt-4o" },
        anthropic: { apiKey: "sk-ant-test-key", model: "claude-3-5-sonnet-20241022" },
      }),
    );
    expect(providers.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
  });
});

describe("buildAiProviderRegistry", () => {
  it("never registers FakeProvider or any Phase 3.3 test fixture provider when env is production", async () => {
    const registry = await buildAiProviderRegistry(ai(), "production");
    expect(registry.has("fake")).toBe(false);
    expect(registry.has("fake-flaky")).toBe(false);
    expect(registry.has("fake-permanent")).toBe(false);
    expect(registry.has("fake-timeout")).toBe(false);
    expect(registry.list()).toHaveLength(0);
  });

  it("registers FakeProvider and the Phase 3.3 test fixtures outside production, unchanged from before Phase 3.4", async () => {
    const registry = await buildAiProviderRegistry(ai(), "development");
    expect(registry.has("fake")).toBe(true);
    expect(registry.has("fake-flaky")).toBe(true);
    expect(registry.has("fake-permanent")).toBe(true);
    expect(registry.has("fake-timeout")).toBe(true);
  });

  it("resolves a production-style registry (real configured providers, no fakes) with no crash at bootstrap", async () => {
    const registry = await buildAiProviderRegistry(ai({ anthropic: { apiKey: "sk-ant-test-key", model: "claude-3-5-sonnet-20241022" } }), "production");
    expect(registry.has("anthropic")).toBe(true);
    expect(() => registry.resolve("openai")).toThrow(/unknown provider/i);
  });
});
