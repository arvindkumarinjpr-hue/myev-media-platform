import { Global, Module } from "@nestjs/common";
import { EventPublisher, EventRegistryBuilder, type EventRegistry } from "@myev/shared";

export const EVENT_REGISTRY = Symbol("EVENT_REGISTRY");
export const EVENT_PUBLISHER = Symbol("EVENT_PUBLISHER");

/**
 * Milestone 8.1 — Event Bus Foundation. Worker-side twin of
 * apps/api/src/modules/events/events.module.ts — both processes build
 * and freeze their own in-memory EventRegistry from the SAME
 * @myev/shared manifest constants, kept in lockstep by construction
 * (reading from one shared source), mirroring how QueueRegistryModule
 * is duplicated per-app today.
 *
 * MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW, §2 (Zero-Consumer
 * Manifest Semantics) — decided Option A: every registered
 * EventConsumerManifest must represent a real, intended consumer. No
 * such consumer exists yet, so this registry deliberately registers
 * NOTHING — see the API-side EventsModule's identical doc comment for
 * the full rationale.
 *
 * No dispatch, no relay, no handler binding exists here — Milestone 8.1
 * is registration/validation and the write-side EventPublisher only
 * (Milestone 8.2+ scope).
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
