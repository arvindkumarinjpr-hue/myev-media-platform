import type { ContentDimension } from "./content-dimension";

/**
 * Module 6 Phase 6.1 — accumulate-then-freeze registry for content-type
 * scoring dimensions.
 *
 * Deliberately identical in shape and discipline to
 * `AgentRegistryBuilder` / `QueueRegistryBuilder` / `AIProviderRegistry
 * Builder`: register every dimension during a single process's bootstrap,
 * `.freeze()` once, get back an immutable registry. "Immutable" is
 * per-process, same caveat as the other registries.
 *
 * This is what makes §11's guarantee structural: the engine resolves
 * dimensions THROUGH this registry, so Module 7 adds Video/Thumbnail by
 * calling `.register()` two more times at bootstrap — never by touching
 * the engine or any existing dimension.
 */

export class ContentDimensionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentDimensionRegistryError";
  }
}

function registryKey(name: string, version: number): string {
  return `${name}@v${version}`;
}

export class ContentDimensionRegistryBuilder {
  private readonly dimensions = new Map<string, ContentDimension>();
  private readonly latestVersionByName = new Map<string, number>();
  private frozen = false;

  register(dimension: ContentDimension): this {
    if (this.frozen) {
      throw new ContentDimensionRegistryError("registry is already frozen — cannot register after bootstrap");
    }
    if (!dimension.name || dimension.name !== dimension.name.toLowerCase()) {
      throw new ContentDimensionRegistryError(`dimension name must be a non-empty lowercase string — got "${dimension.name}"`);
    }
    if (!Number.isInteger(dimension.version) || dimension.version < 1) {
      throw new ContentDimensionRegistryError(`dimension "${dimension.name}" must have a positive integer version`);
    }
    if (dimension.appliesTo.length === 0) {
      throw new ContentDimensionRegistryError(`dimension "${dimension.name}" must declare at least one contentType in appliesTo`);
    }
    const key = registryKey(dimension.name, dimension.version);
    if (this.dimensions.has(key)) {
      throw new ContentDimensionRegistryError(`duplicate dimension registration: "${key}"`);
    }
    this.dimensions.set(key, dimension);
    const currentLatest = this.latestVersionByName.get(dimension.name) ?? 0;
    if (dimension.version > currentLatest) {
      this.latestVersionByName.set(dimension.name, dimension.version);
    }
    return this;
  }

  freeze(): ContentDimensionRegistry {
    if (this.frozen) throw new ContentDimensionRegistryError("registry is already frozen");
    this.frozen = true;
    return new ContentDimensionRegistry(new Map(this.dimensions), new Map(this.latestVersionByName));
  }
}

/** The frozen result of `ContentDimensionRegistryBuilder.freeze()`. No
 * public mutator exists on this class. */
export class ContentDimensionRegistry {
  constructor(
    private readonly dimensions: ReadonlyMap<string, ContentDimension>,
    private readonly latestVersionByName: ReadonlyMap<string, number>,
  ) {}

  /** Resolve by explicit name (+ optional version — defaults to latest
   * registered for that name). */
  resolve(name: string, version?: number): ContentDimension {
    const resolvedVersion = version ?? this.latestVersionByName.get(name);
    if (resolvedVersion === undefined) {
      throw new ContentDimensionRegistryError(`no scoring dimension registered under name "${name}"`);
    }
    const dimension = this.dimensions.get(registryKey(name, resolvedVersion));
    if (!dimension) {
      throw new ContentDimensionRegistryError(`no scoring dimension registered for "${registryKey(name, resolvedVersion)}"`);
    }
    return dimension;
  }

  /** Resolve the (latest) dimension that declares support for a given
   * ContentType. Throws when none does — the caller turns that into a
   * clean "content type not scoreable yet" response. */
  resolveForContentType(contentType: string): ContentDimension {
    const matches: ContentDimension[] = [];
    for (const name of this.latestVersionByName.keys()) {
      const dimension = this.resolve(name);
      if (dimension.appliesTo.includes(contentType)) matches.push(dimension);
    }
    if (matches.length === 0) {
      throw new ContentDimensionRegistryError(`no scoring dimension is registered for contentType "${contentType}"`);
    }
    if (matches.length > 1) {
      const names = matches.map((d) => d.name).sort().join(", ");
      throw new ContentDimensionRegistryError(`ambiguous: multiple dimensions claim contentType "${contentType}" (${names})`);
    }
    return matches[0];
  }

  has(name: string, version?: number): boolean {
    try {
      this.resolve(name, version);
      return true;
    } catch {
      return false;
    }
  }

  hasContentType(contentType: string): boolean {
    try {
      this.resolveForContentType(contentType);
      return true;
    } catch {
      return false;
    }
  }

  /** Registered dimension names, sorted — introspection/tests only. */
  registeredNames(): string[] {
    return [...this.latestVersionByName.keys()].sort();
  }
}
