import type { AgentDefinition } from "./agent-definition";

export class AgentRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRegistryValidationError";
  }
}

function registryKey(identifier: string, version: number): string {
  return `${identifier}@v${version}`;
}

/**
 * Mirrors QueueRegistryBuilder/AIProviderRegistryBuilder's own
 * accumulate-then-freeze discipline exactly — register every
 * AgentDefinition during a single process's own bootstrap, `.freeze()`
 * once, get back an immutable registry. "Immutable" is per-process, same
 * caveat as the other two registries.
 */
export class AgentRegistryBuilder {
  private readonly definitions = new Map<string, AgentDefinition>();
  // Tracks the highest registered version per identifier, so resolve()
  // can deterministically pick "latest" when the caller omits an exact
  // version — never a runtime scan over the whole map.
  private readonly latestVersionByIdentifier = new Map<string, number>();
  private frozen = false;

  register(definition: AgentDefinition): void {
    if (this.frozen) throw new AgentRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    if (!definition.identifier) throw new AgentRegistryValidationError("agent definition must have a non-empty identifier");
    if (!Number.isInteger(definition.version) || definition.version < 1) {
      throw new AgentRegistryValidationError(`agent "${definition.identifier}" must have a positive integer version`);
    }
    const key = registryKey(definition.identifier, definition.version);
    if (this.definitions.has(key)) {
      throw new AgentRegistryValidationError(`duplicate agent registration: "${key}"`);
    }
    this.definitions.set(key, definition);
    const currentLatest = this.latestVersionByIdentifier.get(definition.identifier) ?? 0;
    if (definition.version > currentLatest) {
      this.latestVersionByIdentifier.set(definition.identifier, definition.version);
    }
  }

  freeze(): AgentRegistry {
    if (this.frozen) throw new AgentRegistryValidationError("registry is already frozen");
    this.frozen = true;
    return new AgentRegistry(new Map(this.definitions), new Map(this.latestVersionByIdentifier));
  }
}

/** The frozen result of AgentRegistryBuilder.freeze() — no public mutator exists on this class at all. */
export class AgentRegistry {
  constructor(
    private readonly definitions: ReadonlyMap<string, AgentDefinition>,
    private readonly latestVersionByIdentifier: ReadonlyMap<string, number>,
  ) {}

  /**
   * Throws rather than returning undefined — every call site needs a
   * real definition or a clean, immediate failure. `version` omitted
   * resolves the highest registered version for that identifier
   * deterministically (never a random/insertion-order pick) — the
   * CALLER's own execution-provenance record then captures exactly which
   * version was actually used (Part 4/9's reproducibility requirement),
   * so an implicit "latest" resolution here is safe: it is never silently
   * re-resolved after the fact.
   */
  resolve(identifier: string, version?: number): AgentDefinition {
    const resolvedVersion = version ?? this.latestVersionByIdentifier.get(identifier);
    if (resolvedVersion === undefined) {
      throw new AgentRegistryValidationError(`unknown agent: "${identifier}"`);
    }
    const definition = this.definitions.get(registryKey(identifier, resolvedVersion));
    if (!definition) {
      throw new AgentRegistryValidationError(`unknown agent: "${identifier}@v${resolvedVersion}"`);
    }
    return definition;
  }

  has(identifier: string, version?: number): boolean {
    try {
      this.resolve(identifier, version);
      return true;
    } catch {
      return false;
    }
  }

  list(): AgentDefinition[] {
    return [...this.definitions.values()];
  }
}
