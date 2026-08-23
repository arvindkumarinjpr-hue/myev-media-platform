import { resolveGenerationSettings, type ModelConfig } from "./model-config";

describe("resolveGenerationSettings", () => {
  const config: ModelConfig = {
    provider: "openai",
    model: "gpt-4o",
    defaults: { temperature: 0.3, maxTokens: 1024, timeoutMs: 15_000 },
  };

  it("falls back to the model's configured defaults when no override is given", () => {
    expect(resolveGenerationSettings(config)).toEqual({ temperature: 0.3, maxTokens: 1024, timeoutMs: 15_000 });
  });

  it("lets a runtime override win field-by-field over the configured default", () => {
    expect(resolveGenerationSettings(config, { temperature: 0.9 })).toEqual({ temperature: 0.9, maxTokens: 1024, timeoutMs: 15_000 });
  });

  it("falls back to hardcoded platform defaults when a model has no configured default for a field", () => {
    const sparse: ModelConfig = { provider: "openai", model: "gpt-4o", defaults: {} };
    expect(resolveGenerationSettings(sparse)).toEqual({ temperature: 0.7, maxTokens: 2048, timeoutMs: 30_000 });
  });

  it("does not mutate config.defaults when overrides are applied", () => {
    const original = { ...config.defaults };
    resolveGenerationSettings(config, { temperature: 0.9, maxTokens: 4096, timeoutMs: 60_000 });
    expect(config.defaults).toEqual(original);
  });

  it("produces independent results across repeated calls with different overrides on the same shared config object", () => {
    const first = resolveGenerationSettings(config, { temperature: 0.1 });
    const second = resolveGenerationSettings(config, { temperature: 0.99 });
    expect(first.temperature).toBe(0.1);
    expect(second.temperature).toBe(0.99);
    expect(config.defaults.temperature).toBe(0.3);
  });
});
