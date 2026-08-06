import { validateProcessorManifest, type ProcessorManifest } from "./processor-manifest";
import type { QueueName } from "./queue-name";

// Job payload/context handed to a processor at execution time. Kept
// intentionally minimal and generic — Module 1F itself never defines a
// business job type; this is purely the shape a future module's handler
// receives, not a business contract.
export interface ProcessorContext {
  jobId: string;
  correlationId: string;
  attempt: number;
  isCancelled(): Promise<boolean>;
}

export type ProcessorHandler<TPayload = unknown, TResult = unknown> = (payload: TPayload, context: ProcessorContext) => Promise<TResult>;

export class QueueRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueRegistryValidationError";
  }
}

/**
 * Accumulates registrations during a single process's own module
 * bootstrap. `.freeze()` runs full validation and throws — refusing to
 * start — on any violation, then returns an immutable QueueRegistry.
 * "Immutable" is per-process: each process builds and freezes its own
 * in-memory instance; there is no cross-process shared mutable state.
 */
export class QueueRegistryBuilder {
  private readonly manifests = new Map<string, ProcessorManifest>();
  private readonly handlers = new Map<string, ProcessorHandler>();
  private frozen = false;

  /**
   * Registers a job type's manifest. Required in every process (API and
   * Worker alike) that needs to enqueue, validate, or introspect this job
   * type — never requires a handler.
   */
  registerManifest(manifest: ProcessorManifest): void {
    if (this.frozen) throw new QueueRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    validateProcessorManifest(manifest);
    if (this.manifests.has(manifest.jobType)) {
      throw new QueueRegistryValidationError(`duplicate job type registration: "${manifest.jobType}"`);
    }
    // Per-manifest immutability (independent of the registry collection's
    // own immutability, below) — a mutation attempt against a live
    // reference to this specific object throws rather than silently
    // succeeding. Shallow Object.freeze is sufficient here: every nested
    // value (defaultRetryPolicy) is a plain data object we also freeze
    // explicitly; payloadDto/resultDto are class references, not mutable
    // data.
    if (manifest.defaultRetryPolicy) Object.freeze(manifest.defaultRetryPolicy);
    Object.freeze(manifest);
    this.manifests.set(manifest.jobType, manifest);
  }

  /**
   * Binds a real handler to an already-registered manifest. Worker-only —
   * the API process never calls this, since it never executes anything.
   */
  bindHandler(jobType: string, handler: ProcessorHandler): void {
    if (this.frozen) throw new QueueRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    if (!this.manifests.has(jobType)) {
      throw new QueueRegistryValidationError(`cannot bind a handler for "${jobType}": no ProcessorManifest registered for it`);
    }
    if (this.handlers.has(jobType)) {
      throw new QueueRegistryValidationError(`duplicate handler registration for "${jobType}"`);
    }
    this.handlers.set(jobType, handler);
  }

  /**
   * Freezes the registry. `requireHandlersForQueues`, when provided
   * (Worker only — the categories that worker instance's --queues=
   * selector opens), enforces a strict bijection scoped to exactly that
   * set: every in-scope manifest must resolve to exactly one handler
   * (missing -> fail startup), and every handler must be bound to exactly
   * one manifest (already structurally guaranteed by bindHandler's own
   * duplicate check, re-verified here). The API process calls
   * `.freeze()` with no argument — it legitimately holds handler-less
   * manifests by design, and this bijection does not apply to it.
   */
  freeze(options: { requireHandlersForQueues?: readonly QueueName[] } = {}): QueueRegistry {
    if (this.frozen) throw new QueueRegistryValidationError("registry is already frozen");

    if (options.requireHandlersForQueues) {
      const inScope = new Set(options.requireHandlersForQueues);
      for (const manifest of this.manifests.values()) {
        if (inScope.has(manifest.queue) && !this.handlers.has(manifest.jobType)) {
          throw new QueueRegistryValidationError(
            `manifest "${manifest.jobType}" is in this worker's queue scope (${manifest.queue}) but has no bound handler`,
          );
        }
      }
      for (const jobType of this.handlers.keys()) {
        if (!this.manifests.has(jobType)) {
          // Structurally unreachable given bindHandler's own precondition
          // check, kept as a defensive invariant assertion.
          throw new QueueRegistryValidationError(`handler bound for "${jobType}" but no manifest exists`);
        }
      }
    }

    this.frozen = true;
    return new QueueRegistry(new Map(this.manifests), new Map(this.handlers));
  }
}

/**
 * The frozen result of QueueRegistryBuilder.freeze(). No public mutator
 * exists on this class at all — that absence, not a runtime-throwing
 * proxy over the underlying Maps, is what "the registry remains
 * immutable after bootstrap" means for the collection as a whole. Each
 * individual ProcessorManifest inside it is additionally frozen in its
 * own right (see QueueRegistryBuilder.registerManifest).
 */
export class QueueRegistry {
  constructor(
    private readonly manifests: ReadonlyMap<string, ProcessorManifest>,
    private readonly handlers: ReadonlyMap<string, ProcessorHandler>,
  ) {}

  getManifest(jobType: string): ProcessorManifest | undefined {
    return this.manifests.get(jobType);
  }

  getHandler(jobType: string): ProcessorHandler | undefined {
    return this.handlers.get(jobType);
  }

  listManifests(): ProcessorManifest[] {
    return [...this.manifests.values()];
  }
}
