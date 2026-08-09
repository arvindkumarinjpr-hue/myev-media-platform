import { getMetadataStorage } from "class-validator";
import { QUEUE_NAMES, type QueueName } from "../queue/queue-name";
import type { ClassConstructor, RetryPolicy } from "../queue/processor-manifest";
import { EVENT_TYPE_PATTERN } from "./event-type";

export type EventConsumerStatus = "active" | "deprecated";

/**
 * One (eventType, consumerName) registration — the Event Bus equivalent
 * of ProcessorManifest, and deliberately reusing that shape wherever the
 * concept is identical rather than re-inventing it (Milestone 8
 * Architecture §23, "Consumer Execution Policy": maxExecutionTime IS
 * timeout/maximumRuntime, reused verbatim, not duplicated under a new
 * name). One eventType can have many manifests — one per consumer,
 * mirroring the fan-out design in Milestone 8 Architecture §3/§4 — never
 * a shared mutable registration across consumers.
 *
 * No handler-binding concept exists here (unlike QueueRegistryBuilder) —
 * Milestone 8.1 is registration/validation only, no dispatch (Milestone
 * 8.2+ scope).
 */
export interface EventConsumerManifest<TPayload extends object = object> {
  /** {entity}.{action}.v{n}, past tense — see event-type.ts. */
  eventType: string;
  /** Versions this manifest's own format — integer, starts at 1. */
  schemaVersion: number;
  /** The event contract version — must match eventType's .v{n} suffix exactly (§22). */
  eventContractVersion: number;
  /** This registration's consumer identity — part of the composite registry key. */
  consumerName: string;
  /** Which module/entity produces this event — new in Milestone 8 Architecture §27, not present on ProcessorManifest. */
  producer: string;
  /** Which module owns THIS consumer's handling of the event — reuses ProcessorManifest.owningModule's convention/name exactly. */
  owningModule: string;
  /** active/deprecated — new in §27; a deprecated eventType is not removed, only flagged. */
  status: EventConsumerStatus;
  /** One of the 9 frozen categories (Queue Engine §3) — no new queue category (§10). */
  queue: QueueName;
  payloadDto: ClassConstructor<TPayload>;
  /** Governs whether replay (Milestone 8 Architecture §30) may auto-redeliver to this consumer without manual confirmation. */
  idempotent: boolean;
  cancelable: boolean;
  supportsRetry: boolean;
  defaultRetryPolicy?: RetryPolicy;
  /** Per-attempt execution ceiling — reused from ProcessorManifest, not duplicated (§23). */
  timeout: number;
  /** Absolute ceiling across all attempts — maps to the frozen TIMED_OUT status (Queue Engine §4). */
  maximumRuntime: number;
  description: string;
}

const SUPPORTED_EVENT_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1];
const EVENT_CONSUMER_STATUSES: readonly EventConsumerStatus[] = ["active", "deprecated"];

export class EventConsumerManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventConsumerManifestValidationError";
  }
}

/**
 * Validates a manifest's own internal well-formedness — every check the
 * Event Registry runs at bootstrap before accepting a registration.
 * Fails fast: throws on the first violation found, mirroring
 * validateProcessorManifest exactly.
 */
export function validateEventConsumerManifest(manifest: EventConsumerManifest): void {
  const fail = (message: string): never => {
    throw new EventConsumerManifestValidationError(
      `Invalid EventConsumerManifest for eventType "${manifest.eventType ?? "<unknown>"}" consumer "${manifest.consumerName ?? "<unknown>"}": ${message}`,
    );
  };

  if (!manifest.eventType?.trim()) fail("eventType is required");
  const match = EVENT_TYPE_PATTERN.exec(manifest.eventType);
  if (!match) fail(`eventType "${manifest.eventType}" must match {entity}.{action}.v{n}`);

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    fail("schemaVersion must be a positive integer");
  }
  if (!SUPPORTED_EVENT_MANIFEST_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    fail(
      `schemaVersion ${manifest.schemaVersion} is not recognized by this registry (supported: ${SUPPORTED_EVENT_MANIFEST_SCHEMA_VERSIONS.join(", ")})`,
    );
  }

  if (match) {
    const suffixVersion = Number(match[1]);
    if (suffixVersion !== manifest.eventContractVersion) {
      fail(`eventContractVersion (${manifest.eventContractVersion}) does not match eventType's .v${suffixVersion} suffix`);
    }
  }

  if (!manifest.consumerName?.trim()) fail("consumerName is required");
  if (!manifest.producer?.trim()) fail("producer is required");
  if (!manifest.owningModule?.trim()) fail("owningModule is required");

  if (!EVENT_CONSUMER_STATUSES.includes(manifest.status)) {
    fail(`status must be one of: ${EVENT_CONSUMER_STATUSES.join(", ")}`);
  }

  if (!QUEUE_NAMES.includes(manifest.queue)) {
    fail(`queue "${manifest.queue}" is not one of the 9 recognized categories`);
  }

  if (typeof manifest.payloadDto !== "function") {
    fail("payloadDto is required and must be a class");
  } else if (getMetadataStorage().getTargetValidationMetadatas(manifest.payloadDto, "", false, false).length === 0) {
    fail("payloadDto has no class-validator decorators — refusing an unvalidated placeholder class");
  }

  if (!Number.isFinite(manifest.timeout) || manifest.timeout <= 0) fail("timeout must be a positive number");
  if (!Number.isFinite(manifest.maximumRuntime) || manifest.maximumRuntime <= 0) fail("maximumRuntime must be a positive number");
  if (manifest.timeout > manifest.maximumRuntime) fail("timeout must not exceed maximumRuntime");

  if (manifest.defaultRetryPolicy) {
    if (!Number.isInteger(manifest.defaultRetryPolicy.maxAttempts) || manifest.defaultRetryPolicy.maxAttempts < 1) {
      fail("defaultRetryPolicy.maxAttempts must be a positive integer");
    }
    if (!Number.isFinite(manifest.defaultRetryPolicy.backoffBaseMs) || manifest.defaultRetryPolicy.backoffBaseMs <= 0) {
      fail("defaultRetryPolicy.backoffBaseMs must be a positive number");
    }
    if (!manifest.supportsRetry && manifest.defaultRetryPolicy.maxAttempts > 1) {
      fail("supportsRetry is false but defaultRetryPolicy.maxAttempts allows more than one attempt");
    }
  }

  if (!manifest.description?.trim()) fail("description is required");
}
