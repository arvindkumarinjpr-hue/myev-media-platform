import { FixturePublishingChannelProvider } from "./fixture-publishing-provider";
import { PublishingProviderRegistryBuilder, PublishingProviderRegistryValidationError } from "./publishing-provider-registry";
import type { PublishingChannelType } from "./publishing-types";

function fixture(channelType: PublishingChannelType) {
  return new FixturePublishingChannelProvider({ channelType });
}

describe("PublishingProviderRegistry", () => {
  it("registers and resolves a provider by channel type", () => {
    const builder = new PublishingProviderRegistryBuilder();
    const provider = fixture("WORDPRESS");
    builder.register(provider);
    const registry = builder.freeze();

    expect(registry.resolve("WORDPRESS")).toBe(provider);
    expect(registry.has("WORDPRESS")).toBe(true);
    expect(registry.has("YOUTUBE")).toBe(false);
  });

  it("rejects duplicate channel registration", () => {
    const builder = new PublishingProviderRegistryBuilder();
    builder.register(fixture("WORDPRESS"));
    expect(() => builder.register(fixture("WORDPRESS"))).toThrow(PublishingProviderRegistryValidationError);
  });

  it("rejects registration after freeze", () => {
    const builder = new PublishingProviderRegistryBuilder();
    builder.freeze();
    expect(() => builder.register(fixture("WORDPRESS"))).toThrow(PublishingProviderRegistryValidationError);
  });

  it("rejects freezing twice", () => {
    const builder = new PublishingProviderRegistryBuilder();
    builder.freeze();
    expect(() => builder.freeze()).toThrow(PublishingProviderRegistryValidationError);
  });

  it("throws a typed error resolving an unregistered channel, never returns undefined", () => {
    const registry = new PublishingProviderRegistryBuilder().freeze();
    expect(() => registry.resolve("YOUTUBE")).toThrow(PublishingProviderRegistryValidationError);
  });

  it("list() returns every registered provider", () => {
    const builder = new PublishingProviderRegistryBuilder();
    const wordpress = fixture("WORDPRESS");
    const youtube = fixture("YOUTUBE");
    builder.register(wordpress);
    builder.register(youtube);
    const registry = builder.freeze();

    expect(registry.list()).toEqual(expect.arrayContaining([wordpress, youtube]));
    expect(registry.list()).toHaveLength(2);
  });

  it("registry is immutable after freeze — no mutator method exists on the frozen class", () => {
    const registry = new PublishingProviderRegistryBuilder().freeze();
    expect((registry as unknown as { register?: unknown }).register).toBeUndefined();
  });
});
