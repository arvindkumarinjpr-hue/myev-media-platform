import { validateProcessorManifest, type ProcessorManifest } from "../queue/processor-manifest";
import type { EventConsumerManifest } from "./event-consumer-manifest";
import { EventConsumerJobEnvelopeDto } from "./event-consumer-job-envelope";
import { deriveEventConsumerJobType } from "./event-consumer-job-type";

/**
 * Milestone 8.3 FINAL ARCHITECTURE FREEZE §1/§4 — the single place an
 * EventConsumerManifest becomes the ProcessorManifest a Worker process
 * registers/binds a handler against. Reuses, never re-declares, every
 * field the two manifests share (queue/timeout/maximumRuntime/
 * supportsRetry/defaultRetryPolicy/owningModule) — the one deliberate
 * exception is `payloadDto`, which is NOT copied from
 * EventConsumerManifest: the derived ProcessorManifest's payloadDto is
 * always the fixed EventConsumerJobEnvelopeDto, because the BullMQ job
 * body is the reference envelope, not the business payload (see
 * event-consumer-job-envelope.ts). EventConsumerManifest.payloadDto
 * remains the business DTO, used separately at execution time against
 * the freshly-reloaded DomainEvent.payload — never here.
 *
 * `schemaVersion` is deliberately NOT derived from
 * EventConsumerManifest.schemaVersion — the two fields version
 * different, unrelated things (ProcessorManifest's own manifest FORMAT
 * vs EventConsumerManifest's own manifest FORMAT; see
 * processor-manifest.ts's own three-way "version" disambiguation). `1`
 * is the current, only supported ProcessorManifest schema version,
 * matching every other manifest in this codebase (e.g. system.ping.v1).
 *
 * The output is validated through validateProcessorManifest — the
 * existing, unmodified rule set — before being returned, so a
 * structurally invalid derivation (e.g. a field that survives
 * straight-through copying but violates a ProcessorManifest-specific
 * constraint) fails loudly here rather than later at registry-freeze
 * time.
 */
export function deriveProcessorManifestFromEventConsumerManifest(
  manifest: EventConsumerManifest,
): ProcessorManifest<EventConsumerJobEnvelopeDto> {
  const derived: ProcessorManifest<EventConsumerJobEnvelopeDto> = {
    jobType: deriveEventConsumerJobType(manifest.consumerName, manifest.eventContractVersion),
    schemaVersion: 1,
    version: manifest.eventContractVersion,
    queue: manifest.queue,
    payloadDto: EventConsumerJobEnvelopeDto,
    idempotent: manifest.idempotent,
    cancelable: manifest.cancelable,
    supportsRetry: manifest.supportsRetry,
    defaultRetryPolicy: manifest.defaultRetryPolicy,
    timeout: manifest.timeout,
    maximumRuntime: manifest.maximumRuntime,
    owningModule: manifest.owningModule,
    description: `Event-consumer execution job for consumer "${manifest.consumerName}" of eventType "${manifest.eventType}". ${manifest.description}`,
  };

  validateProcessorManifest(derived);
  return derived;
}
