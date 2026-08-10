import { IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Min } from "class-validator";
import { EVENT_TYPE_PATTERN } from "./event-type";

/**
 * Milestone 8.3 FINAL CONTRACT CORRECTION §1/§5 — the canonical, durable
 * reference envelope carried as BOTH the BullMQ job's own `data` and
 * `BackgroundJob.payloadMetadata` for every `event.*` jobType. Never the
 * business payload itself (that remains `DomainEvent.payload`,
 * authoritative, reloaded fresh at execution time — see
 * event-consumer-runtime.ts). correlationId/causationId/workspaceId are
 * `string | null`, not `string`, because DomainEventRecord's own fields
 * are nullable and OutboxRelayManager never generates a fallback for
 * them today — coercing null to a required string here would silently
 * misrepresent that fact.
 */
export interface EventConsumerJobEnvelope {
  domainEventId: string;
  eventType: string;
  eventVersion: number;
  consumerName: string;
  workspaceId: string | null;
  correlationId: string | null;
  causationId: string | null;
}

/**
 * The class-validator-decorated form registered as the derived
 * ProcessorManifest's own `payloadDto` (see
 * derive-processor-manifest-from-event-consumer-manifest.ts) — validated
 * by BullMqWorkerManager's existing, unmodified pickup-time payload
 * validation step, exactly like any other job type's payloadDto.
 */
export class EventConsumerJobEnvelopeDto implements EventConsumerJobEnvelope {
  @IsUUID()
  domainEventId!: string;

  @Matches(EVENT_TYPE_PATTERN)
  eventType!: string;

  @IsInt()
  @Min(1)
  eventVersion!: number;

  // Consistent with EventConsumerManifest's own consumerName rule
  // (validateEventConsumerManifest: non-empty, trimmed) — no additional
  // format constraint here. The stricter segment-pattern constraint
  // required to derive a valid jobType lives in
  // event-consumer-job-type.ts, a distinct concern from "is this a
  // well-formed piece of carried data."
  @IsString()
  @IsNotEmpty()
  consumerName!: string;

  @IsOptional()
  @IsUUID()
  workspaceId!: string | null;

  @IsOptional()
  @IsString()
  correlationId!: string | null;

  @IsOptional()
  @IsString()
  causationId!: string | null;
}
