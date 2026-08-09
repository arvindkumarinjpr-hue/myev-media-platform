import { validateEventConsumerManifest, type EventConsumerManifest } from "./event-consumer-manifest";

export class EventRegistryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventRegistryValidationError";
  }
}

// One eventType can have many consumers (fan-out, Milestone 8
// Architecture §3/§4) — the registration key is the composite pair, not
// eventType alone, mirroring ProcessedEvent's own @@unique([eventId,
// consumerName]) key shape.
function registrationKey(eventType: string, consumerName: string): string {
  return `${eventType}:${consumerName}`;
}

/**
 * Accumulates EventConsumerManifest registrations during a single
 * process's own module bootstrap. `.freeze()` runs full validation and
 * throws — refusing to start — on any violation, then returns an
 * immutable EventRegistry. Mirrors QueueRegistryBuilder exactly, minus
 * handler binding: Milestone 8.1 is registration/validation only — no
 * dispatch, no relay, no handler concept exists yet (Milestone 8.2+
 * scope).
 */
export class EventRegistryBuilder {
  private readonly manifests = new Map<string, EventConsumerManifest>();
  private frozen = false;

  /**
   * Registers one (eventType, consumerName) manifest. Required in every
   * process that needs to know this consumer exists (bootstrap
   * validation, future relay dispatch, the Event Registry documentation
   * view, Milestone 8 Architecture §27) — never requires a handler.
   */
  registerManifest(manifest: EventConsumerManifest): void {
    if (this.frozen) throw new EventRegistryValidationError("registry is already frozen — cannot register after bootstrap");
    validateEventConsumerManifest(manifest);
    const key = registrationKey(manifest.eventType, manifest.consumerName);
    if (this.manifests.has(key)) {
      throw new EventRegistryValidationError(`duplicate consumer registration: eventType "${manifest.eventType}", consumer "${manifest.consumerName}"`);
    }
    // MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW §4: "producer"
    // describes who produces the EVENT TYPE, not who consumes it — it is
    // stored per-manifest only for simplicity (Milestone 8 Architecture
    // §27), so nothing else prevents two different consumers' manifests
    // for the same eventType from silently disagreeing on it. That would
    // be a genuine contradiction (two different claimed sources of truth
    // for the same fact), not a legitimate difference of opinion, so it
    // fails bootstrap loudly rather than silently accepting whichever
    // manifest happened to register first.
    const existingForEventType = [...this.manifests.values()].find((existing) => existing.eventType === manifest.eventType);
    if (existingForEventType && existingForEventType.producer !== manifest.producer) {
      throw new EventRegistryValidationError(
        `eventType "${manifest.eventType}" already registered with producer "${existingForEventType.producer}" ` +
          `(consumer "${existingForEventType.consumerName}") — consumer "${manifest.consumerName}" declares a different producer "${manifest.producer}"`,
      );
    }
    // Per-manifest immutability, same reasoning as QueueRegistryBuilder's
    // own registerManifest: shallow Object.freeze suffices since every
    // nested value (defaultRetryPolicy) is a plain data object also
    // frozen explicitly; payloadDto is a class reference, not mutable data.
    if (manifest.defaultRetryPolicy) Object.freeze(manifest.defaultRetryPolicy);
    Object.freeze(manifest);
    this.manifests.set(key, manifest);
  }

  freeze(): EventRegistry {
    if (this.frozen) throw new EventRegistryValidationError("registry is already frozen");
    this.frozen = true;
    return new EventRegistry(new Map(this.manifests));
  }
}

/**
 * The frozen result of EventRegistryBuilder.freeze(). No public mutator
 * exists — the collection's own immutability is structural, mirroring
 * QueueRegistry exactly.
 */
export class EventRegistry {
  constructor(private readonly manifests: ReadonlyMap<string, EventConsumerManifest>) {}

  getManifest(eventType: string, consumerName: string): EventConsumerManifest | undefined {
    return this.manifests.get(registrationKey(eventType, consumerName));
  }

  /** All registered consumers for one eventType — the fan-out list (Milestone 8 Architecture §3). */
  getConsumersForEventType(eventType: string): EventConsumerManifest[] {
    return [...this.manifests.values()].filter((manifest) => manifest.eventType === eventType);
  }

  listManifests(): EventConsumerManifest[] {
    return [...this.manifests.values()];
  }
}
