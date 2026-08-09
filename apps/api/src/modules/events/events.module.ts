import { Global, Module } from "@nestjs/common";
import { EventPublisher, EventRegistryBuilder, type EventRegistry } from "@myev/shared";

export const EVENT_REGISTRY = Symbol("EVENT_REGISTRY");
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

/**
 * Milestone 8.1 — Event Bus Foundation. Mirrors QueueRegistryModule's
 * own bootstrap-validation design exactly: EVENT_REGISTRY is a factory
 * provider resolved eagerly during NestFactory.createApplicationContext()
 * (or Test.createTestingModule(...).compile() in tests), so a
 * malformed/duplicate EventConsumerManifest throws before the
 * application context ever finishes starting — the same "fail-fast
 * bootstrap validation" the frozen Module 1F Engineering Plan mandates
 * for the Job Registry, applied here to the Event Registry.
 *
 * MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW, §2 (Zero-Consumer
 * Manifest Semantics) — decided Option A: every registered
 * EventConsumerManifest must represent a real, intended consumer. No
 * such consumer exists yet (Module 2+ has not started), so this
 * registry deliberately registers NOTHING — freezing an empty builder
 * is itself the bootstrap-validation proof (an empty registry is a
 * valid, successfully-freezable state, not an error). The example
 * SystemProbeEmitted fixture in @myev/shared is test-only and must
 * never be registered here — see its own doc comment.
 *
 * No dispatch, no relay, no handler binding exists here — Milestone 8.1
 * is registration/validation and the write-side EventPublisher only
 * (Milestone 8.2+ scope). EVENT_PUBLISHER is provided as a plain
 * singleton — EventPublisher is stateless and dependency-free, so no
 * factory is needed.
 */
@Global()
@Module({
  providers: [
    {
      provide: EVENT_REGISTRY,
      useFactory: (): EventRegistry => new EventRegistryBuilder().freeze(),
    },
    {
      provide: EVENT_PUBLISHER,
      useValue: new EventPublisher(),
    },
  ],
  exports: [EVENT_REGISTRY, EVENT_PUBLISHER],
})
export class EventsModule {}
