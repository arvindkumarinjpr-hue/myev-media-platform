import { IsOptional, IsString } from "class-validator";
import type { EventConsumerManifest } from "../event-consumer-manifest";

/**
 * The one trivial event type Milestone 8.1 itself owns — not a business
 * event, mirroring system.ping.v1's identical role for the Queue Engine
 * (Milestone 1F Milestone 3). Exists purely to prove the Event Bus
 * Foundation (EventPublisher, EventConsumerManifest, EventRegistryBuilder)
 * compiles, validates, and registers correctly, end-to-end, without
 * depending on any future module's business logic. No AI/Blog/Video/
 * Publishing/Content module may depend on this event type.
 *
 * No relay, no dispatch, no handler exists for this event in Milestone
 * 8.1 — registering its manifest only proves bootstrap validation and
 * manifest discovery work; publishing it only proves the write side
 * round-trips through a real Prisma transaction. Nothing consumes it.
 */
export class SystemProbeEmittedPayload {
  @IsOptional()
  @IsString()
  note?: string;
}

export const SYSTEM_PROBE_EMITTED_V1_EVENT_TYPE = "system.probe-emitted.v1";

/**
 * MILESTONE 8.1 FINAL VALIDATION & CONTRACT REVIEW, §2 (Zero-Consumer
 * Manifest Semantics) — decided Option A: every registered
 * EventConsumerManifest must represent a real, intended consumer. This
 * fixture's "audit-log-recorder" names no real, intended consumer — it
 * exists purely to exercise EventRegistryBuilder's mechanics
 * (registration, validation, duplicate detection, freeze) in tests.
 *
 * Per that decision, this constant MUST NOT be registered in any
 * production EventsModule (apps/api or apps/worker) — doing so would be
 * exactly the "masquerading as a consumer manifest" the decision
 * rejects. It is a test-only fixture, used by
 * packages/shared/src/events/event-registry.spec.ts's own local
 * manifest() helper pattern and by apps/api's real-Prisma
 * EventPublisher round-trip test (which needs a well-formed eventType,
 * not a registry entry). The production EVENT_REGISTRY in both apps is
 * therefore currently and correctly EMPTY — see events.module.ts in
 * each app — until a real module registers its first genuine consumer.
 */
export const SYSTEM_PROBE_EMITTED_V1_AUDIT_LOG_MANIFEST: EventConsumerManifest<SystemProbeEmittedPayload> = {
  eventType: SYSTEM_PROBE_EMITTED_V1_EVENT_TYPE,
  schemaVersion: 1,
  eventContractVersion: 1,
  consumerName: "audit-log-recorder",
  producer: "system-services-foundation",
  owningModule: "system-services-foundation",
  status: "active",
  queue: "SYSTEM",
  payloadDto: SystemProbeEmittedPayload,
  idempotent: true,
  cancelable: false,
  supportsRetry: true,
  defaultRetryPolicy: { maxAttempts: 3, backoffBaseMs: 30_000 },
  timeout: 5_000,
  maximumRuntime: 30_000,
  description: "Trivial internal event proving the Event Bus Foundation end-to-end. No real consumer exists yet.",
};
