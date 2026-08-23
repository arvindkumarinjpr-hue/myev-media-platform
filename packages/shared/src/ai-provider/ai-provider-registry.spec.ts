import { AIProviderRegistryBuilder, AIProviderRegistryValidationError } from "./ai-provider-registry";
import { FakeProvider } from "./providers/fake-provider";

describe("AIProviderRegistryBuilder", () => {
  it("resolves a provider by id after freezing", () => {
    const builder = new AIProviderRegistryBuilder();
    const fake = new FakeProvider();
    builder.register(fake);
    const registry = builder.freeze();
    expect(registry.resolve("fake")).toBe(fake);
  });

  it("throws AIProviderRegistryValidationError for an unknown provider id rather than returning undefined", () => {
    const registry = new AIProviderRegistryBuilder().freeze();
    expect(() => registry.resolve("nonexistent")).toThrow(AIProviderRegistryValidationError);
    expect(() => registry.resolve("nonexistent")).toThrow(/unknown provider/);
  });

  it("rejects a duplicate provider registration", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    expect(() => builder.register(new FakeProvider())).toThrow(AIProviderRegistryValidationError);
    expect(() => builder.register(new FakeProvider())).toThrow(/duplicate provider registration/);
  });

  it("rejects registration after freeze", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.freeze();
    expect(() => builder.register(new FakeProvider())).toThrow(/already frozen/);
  });

  it("has() reports presence without throwing", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider());
    const registry = builder.freeze();
    expect(registry.has("fake")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("list() returns every registered provider", () => {
    const builder = new AIProviderRegistryBuilder();
    builder.register(new FakeProvider("success"));
    const registry = builder.freeze();
    expect(registry.list()).toHaveLength(1);
    expect(registry.list()[0]?.id).toBe("fake");
  });
});
