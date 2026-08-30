import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  PermanentProcessorError,
  wrapExternalEffectConsumer,
  wrapTransactionalConsumer,
  type CategoryAConsumerDeps,
  type CategoryAExecute,
  type CategoryBConsumerDeps,
  type CategoryBExecute,
  type DomainEventRecord,
  type EventConsumerExecutionOutcome,
  type EventConsumerJobEnvelope,
  type EventConsumerManifest,
  type ProcessorContext,
  type ProcessorHandler,
} from "@myev/shared";
import { PrismaService } from "@myev/worker-core";

/**
 * Milestone 8.3 Phase 4 — the one place an EventConsumerManifest's
 * business logic (Category A or B) becomes a real, bound ProcessorHandler
 * a Worker process executes. Not a lifecycle manager — no bootstrap/
 * shutdown hook, no Redis/BullMQ ownership, no timer. A pure function
 * factory, the same shape as SystemPingProcessor.handle: BullMqWorkerManager
 * (unmodified, Phase 2) invokes whatever this factory returns exactly
 * like any other ProcessorHandler, and uses its own existing success
 * path to mark the BackgroundJob COMPLETED — no retry/dead-letter logic
 * is duplicated here.
 *
 * `envelope` arrives already validated against EventConsumerJobEnvelopeDto
 * by BullMqWorkerManager's own existing, unmodified pickup-time step (the
 * derived ProcessorManifest's payloadDto, per Milestone 8.3's frozen
 * derivation, IS the envelope DTO) — this function never trusts it as
 * authoritative for anything beyond identifying which DomainEvent to
 * reload. The authoritative business payload is always the freshly
 * reloaded DomainEvent.payload, revalidated here against
 * EventConsumerManifest.payloadDto — never BackgroundJob.payloadMetadata
 * or the BullMQ job.data, which only ever carry the envelope.
 */
async function loadAndValidateDomainEvent(
  prisma: PrismaService,
  manifest: EventConsumerManifest,
  envelope: EventConsumerJobEnvelope,
): Promise<DomainEventRecord> {
  const row = await prisma.domainEvent.findUnique({ where: { id: envelope.domainEventId } });
  if (!row) {
    throw new PermanentProcessorError("DOMAIN_EVENT_NOT_FOUND", "The referenced domain event no longer exists.");
  }
  if (row.eventType !== envelope.eventType || row.eventVersion !== envelope.eventVersion) {
    throw new PermanentProcessorError("EVENT_ENVELOPE_MISMATCH", "The queued envelope no longer matches the authoritative domain event's type/version.");
  }
  if (envelope.consumerName !== manifest.consumerName) {
    throw new PermanentProcessorError("EVENT_ENVELOPE_MISMATCH", "The queued envelope's consumerName does not match this handler's own manifest.");
  }
  if ((row.workspaceId ?? null) !== envelope.workspaceId) {
    throw new PermanentProcessorError("EVENT_ENVELOPE_MISMATCH", "The queued envelope's workspaceId does not match the authoritative domain event.");
  }

  const businessPayload = plainToInstance(manifest.payloadDto, row.payload);
  const validationErrors = await validate(businessPayload);
  if (validationErrors.length > 0) {
    throw new PermanentProcessorError("PAYLOAD_VALIDATION_FAILED", "The domain event payload failed validation for this consumer.");
  }

  // Frozen CategoryA/BExecute signatures (Milestone 8.3 Phase 1) pass a
  // DomainEventRecord, whose own `payload` field is typed `unknown` —
  // deliberately wide enough to carry the already-validated/transformed
  // instance below rather than the raw, untyped JSON a business callback
  // would otherwise have to re-parse unsafely itself. No change to that
  // frozen interface was needed for this.
  return {
    id: row.id,
    eventType: row.eventType,
    eventVersion: row.eventVersion,
    workspaceId: row.workspaceId,
    correlationId: row.correlationId,
    causationId: row.causationId,
    payload: businessPayload,
    occurredAt: row.occurredAt,
    dispatchedAt: row.dispatchedAt,
  };
}

/** Category A — transaction-bound execution, per manifest/consumer. */
export function createTransactionalEventConsumerHandler<TTx, TResult>(
  manifest: EventConsumerManifest,
  prisma: PrismaService,
  deps: CategoryAConsumerDeps<TTx>,
  execute: CategoryAExecute<TTx, TResult>,
): ProcessorHandler<EventConsumerJobEnvelope, EventConsumerExecutionOutcome<TResult>> {
  return async (envelope: EventConsumerJobEnvelope, context: ProcessorContext) => {
    const domainEvent = await loadAndValidateDomainEvent(prisma, manifest, envelope);
    return wrapTransactionalConsumer(deps, domainEvent, manifest.consumerName, context, execute);
  };
}

/** Category B — external-effect execution, per manifest/consumer. */
export function createExternalEffectEventConsumerHandler<TResult>(
  manifest: EventConsumerManifest,
  prisma: PrismaService,
  deps: CategoryBConsumerDeps,
  execute: CategoryBExecute<TResult>,
): ProcessorHandler<EventConsumerJobEnvelope, EventConsumerExecutionOutcome<TResult>> {
  return async (envelope: EventConsumerJobEnvelope, context: ProcessorContext) => {
    const domainEvent = await loadAndValidateDomainEvent(prisma, manifest, envelope);
    return wrapExternalEffectConsumer(deps, domainEvent, manifest.consumerName, context, execute);
  };
}
