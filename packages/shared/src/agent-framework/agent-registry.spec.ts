import "reflect-metadata";
import { AgentRegistryBuilder, AgentRegistryValidationError } from "./agent-registry";
import { TEST_ECHO_AGENT_V1 } from "./test-agent";
import type { AgentDefinition } from "./agent-definition";

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return { ...TEST_ECHO_AGENT_V1, ...overrides };
}

describe("AgentRegistryBuilder", () => {
  it("registers and resolves an agent by identifier and exact version", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(TEST_ECHO_AGENT_V1);
    const registry = builder.freeze();
    expect(registry.resolve("test-echo-agent", 1)).toBe(TEST_ECHO_AGENT_V1);
  });

  it("resolves the highest registered version deterministically when version is omitted", () => {
    const builder = new AgentRegistryBuilder();
    const v1 = definition({ version: 1 });
    const v2 = definition({ version: 2 });
    builder.register(v1);
    builder.register(v2);
    const registry = builder.freeze();
    expect(registry.resolve("test-echo-agent")).toBe(v2);
  });

  it("rejects a duplicate identifier+version registration", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(TEST_ECHO_AGENT_V1);
    expect(() => builder.register(TEST_ECHO_AGENT_V1)).toThrow(AgentRegistryValidationError);
    expect(() => builder.register(TEST_ECHO_AGENT_V1)).toThrow(/duplicate agent registration/);
  });

  it("allows two different versions of the same identifier", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(definition({ version: 1 }));
    expect(() => builder.register(definition({ version: 2 }))).not.toThrow();
  });

  it("rejects registration after freeze", () => {
    const builder = new AgentRegistryBuilder();
    builder.freeze();
    expect(() => builder.register(TEST_ECHO_AGENT_V1)).toThrow(/already frozen/);
  });

  it("rejects a non-positive-integer version", () => {
    const builder = new AgentRegistryBuilder();
    expect(() => builder.register(definition({ version: 0 }))).toThrow(AgentRegistryValidationError);
    expect(() => builder.register(definition({ version: -1 }))).toThrow(AgentRegistryValidationError);
  });

  it("throws AgentRegistryValidationError for an unknown identifier rather than returning undefined", () => {
    const registry = new AgentRegistryBuilder().freeze();
    expect(() => registry.resolve("nonexistent")).toThrow(AgentRegistryValidationError);
    expect(() => registry.resolve("nonexistent")).toThrow(/unknown agent/);
  });

  it("throws for a known identifier but an unregistered exact version", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(definition({ version: 1 }));
    const registry = builder.freeze();
    expect(() => registry.resolve("test-echo-agent", 99)).toThrow(/unknown agent/);
  });

  it("has() reports presence without throwing", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(TEST_ECHO_AGENT_V1);
    const registry = builder.freeze();
    expect(registry.has("test-echo-agent", 1)).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("list() returns every registered definition", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(definition({ version: 1 }));
    builder.register(definition({ version: 2 }));
    const registry = builder.freeze();
    expect(registry.list()).toHaveLength(2);
  });
});
