import { getMetadataStorage } from "class-validator";
import { QUEUE_NAMES, type QueueName } from "./queue-name";

/**
 * A job-type payload/result shape — a class-validator-decorated class,
 * never a plain interface. Constructor signature is deliberately loose
 * (`unknown[]`) since manifests never instantiate this themselves; they
 * only ever hold the class reference for validation (class-validator's
 * own metadata reflection) and, at the API/Worker boundary, for
 * class-transformer's plainToInstance.
 */
export type ClassConstructor<T = object> = new (...args: unknown[]) => T;

export interface RetryPolicy {
  maxAttempts: number;
  backoffBaseMs: number;
}

/**
 * The single source of truth for a job type's contract, behavior, and
 * ownership — Module 1F Engineering Plan §4. One declaration, consumed
 * identically by both the API process (enqueue/cancel/retry validation,
 * no handler needed) and the Worker process (which additionally binds a
 * handler on top — see ProcessorBinding in queue-registry.ts). Never
 * duplicated: every other part of the system reads from this object
 * rather than re-declaring any part of it.
 *
 * Three distinct "version" concepts exist in this module — this is the
 * complete, final disambiguation, stated once:
 *   - `schemaVersion` (this interface) — versions the MANIFEST FORMAT
 *     itself (the shape of ProcessorManifest as a type). Changes only
 *     when the registry's own definition of what a manifest must contain
 *     changes.
 *   - `version` (this interface, and the jobType's own `.v{n}` suffix) —
 *     versions the JOB CONTRACT (payload/behavior shape) for that job
 *     type. Changes when a job type's payload or behavioral contract
 *     changes in a breaking way.
 *   - `processor_version` (background_jobs column, apps/api) — the
 *     DEPLOYED CODE that executed one specific job instance. Changes
 *     every deploy, sourced from WorkerHeartbeat.applicationVersion.
 * None of these three is derivable from either of the others.
 */
export interface ProcessorManifest<TPayload extends object = object, TResult extends object = object> {
  /** Full versioned registry key, e.g. "system.ping.v1". */
  jobType: string;
  /** Versions this manifest's own format — integer, starts at 1. */
  schemaVersion: number;
  /** The job contract version — must match jobType's ".v{n}" suffix exactly. */
  version: number;
  queue: QueueName;
  payloadDto: ClassConstructor<TPayload>;
  resultDto?: ClassConstructor<TResult>;
  /**
   * Governs whether the engine's at-least-once recovery paths (outbox
   * relay redelivery, ambiguous-crash-recovery redispatch) may apply to
   * this job type. false does not disable retry (see supportsRetry) — it
   * means an ambiguous crash-recovery scenario must be surfaced
   * distinctly (high-severity log/alert) rather than silently redispatch
   * as if safe.
   */
  idempotent: boolean;
  /**
   * false means this job type was never designed with a safe
   * interruption checkpoint — the cancel endpoint rejects with
   * 409 JOB_TYPE_NOT_CANCELABLE before ever touching a job row, rather
   * than accepting a request a processor was never going to check for.
   */
  cancelable: boolean;
  /**
   * false forces maxAttempts=1 for this job type unconditionally, even
   * for an otherwise-transient error — some job types have real-world
   * side effects that can never safely retry.
   */
  supportsRetry: boolean;
  defaultRetryPolicy?: RetryPolicy;
  /** Per-attempt execution ceiling. */
  timeout: number;
  /** Absolute ceiling across all attempts combined — maps to the frozen TIMED_OUT status. */
  maximumRuntime: number;
  owningModule: string;
  description: string;
}

const SUPPORTED_MANIFEST_SCHEMA_VERSIONS: readonly number[] = [1];
const JOB_TYPE_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*\.v(\d+)$/;

export class ProcessorManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProcessorManifestValidationError";
  }
}

/**
 * Validates a manifest's own internal well-formedness — every check the
 * Job Registry runs at bootstrap before accepting a registration. Fails
 * fast: throws on the first violation found, never partially accepts a
 * manifest.
 */
export function validateProcessorManifest(manifest: ProcessorManifest): void {
  const fail = (message: string): never => {
    throw new ProcessorManifestValidationError(`Invalid ProcessorManifest for jobType "${manifest.jobType ?? "<unknown>"}": ${message}`);
  };

  if (!manifest.jobType?.trim()) fail("jobType is required");
  const match = JOB_TYPE_PATTERN.exec(manifest.jobType);
  if (!match) fail(`jobType "${manifest.jobType}" must match {domain}.{action}.v{n}`);

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion < 1) {
    fail("schemaVersion must be a positive integer");
  }
  if (!SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
    fail(`schemaVersion ${manifest.schemaVersion} is not recognized by this registry (supported: ${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(", ")})`);
  }

  if (match) {
    const suffixVersion = Number(match[1]);
    if (suffixVersion !== manifest.version) {
      fail(`version (${manifest.version}) does not match jobType's .v${suffixVersion} suffix`);
    }
  }

  if (!QUEUE_NAMES.includes(manifest.queue)) {
    fail(`queue "${manifest.queue}" is not one of the 9 recognized categories`);
  }

  if (typeof manifest.payloadDto !== "function") {
    fail("payloadDto is required and must be a class");
  } else if (getMetadataStorage().getTargetValidationMetadatas(manifest.payloadDto, "", false, false).length === 0) {
    fail("payloadDto has no class-validator decorators — refusing an unvalidated placeholder class");
  }
  if (manifest.resultDto !== undefined) {
    if (typeof manifest.resultDto !== "function") {
      fail("resultDto, if provided, must be a class");
    } else if (getMetadataStorage().getTargetValidationMetadatas(manifest.resultDto, "", false, false).length === 0) {
      fail("resultDto has no class-validator decorators — refusing an unvalidated placeholder class");
    }
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
    // The one cross-field consistency check the unified manifest makes
    // possible: a job type declaring it cannot be retried must not also
    // configure a multi-attempt policy — self-contradictory, rejected at
    // bootstrap rather than silently favoring one field over the other.
    if (!manifest.supportsRetry && manifest.defaultRetryPolicy.maxAttempts > 1) {
      fail("supportsRetry is false but defaultRetryPolicy.maxAttempts allows more than one attempt");
    }
  }

  if (!manifest.owningModule?.trim()) fail("owningModule is required");
  if (!manifest.description?.trim()) fail("description is required");
}
