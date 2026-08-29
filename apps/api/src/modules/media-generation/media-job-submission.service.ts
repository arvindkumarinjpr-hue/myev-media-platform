import { createHash } from "crypto";
import { Injectable } from "@nestjs/common";
import {
  MEDIA_IMAGE_GENERATE_V1_MANIFEST,
  MEDIA_SUBTITLE_GENERATE_V1_MANIFEST,
  MEDIA_TTS_V1_MANIFEST,
} from "@myev/shared";
import type { MediaJob, MediaJobOperation, Prisma } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { BackgroundJobsService } from "../background-jobs/background-jobs.service";

/**
 * Module 7 Phase 7.4 — durable media-job submission.
 *
 * Architectural precedent (not copy-paste authority) is
 * `AiJobSubmissionService`: create the authoritative business row
 * (`media_jobs`), durably enqueue a generic `background_jobs` row that
 * references it by public_id, then link the two. Provider calls NEVER
 * happen here — only in the MEDIA-queue worker processors. No new queue
 * system.
 *
 * Idempotency is at the `media_jobs` level (the BullMQ payload carries a
 * per-row public_id, so enqueue-level dedup can't apply): a caller-
 * supplied `fingerprint` — derived from the operation + the stable
 * upstream inputs (scene id, script hash, concept index …) — is stamped
 * into `input_payload._fingerprint`. A resubmission with a matching
 * fingerprint against a still-live row (QUEUED / RUNNING / COMPLETED)
 * returns that row instead of creating a duplicate. A genuinely new
 * request (after a regeneration changed the upstream inputs) has a
 * different fingerprint and gets a fresh job.
 */
export interface SubmitMediaJobInput {
  workspaceId: string;
  contentItemInternalId: string;
  operation: MediaJobOperation;
  /** Everything the worker processor needs — resolved, never a raw provider request. */
  inputPayload: Record<string, unknown>;
  /** Stable identity for idempotency (the operation is folded in by `fingerprint()`). */
  fingerprint: string;
  correlationId: string;
  actorUserInternalId: string;
}

const JOB_TYPE_BY_OPERATION: Record<MediaJobOperation, string> = {
  IMAGE_GENERATE: MEDIA_IMAGE_GENERATE_V1_MANIFEST.jobType,
  TTS: MEDIA_TTS_V1_MANIFEST.jobType,
  SUBTITLE_GENERATE: MEDIA_SUBTITLE_GENERATE_V1_MANIFEST.jobType,
};

const LIVE_STATUSES: MediaJob["status"][] = ["QUEUED", "RUNNING", "COMPLETED"];

@Injectable()
export class MediaJobSubmissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly backgroundJobs: BackgroundJobsService,
  ) {}

  /** Deterministic short digest over the operation + stable parts. */
  static fingerprint(operation: MediaJobOperation, parts: Array<string | number | null | undefined>): string {
    return createHash("sha256")
      .update([operation, ...parts.map((p) => String(p ?? ""))].join("|"))
      .digest("hex")
      .slice(0, 32);
  }

  async submit(input: SubmitMediaJobInput): Promise<{ job: MediaJob; deduplicated: boolean }> {
    const existing = await this.prisma.mediaJob.findFirst({
      where: {
        workspaceId: input.workspaceId,
        contentItemId: input.contentItemInternalId,
        operation: input.operation,
        status: { in: LIVE_STATUSES },
        deletedAt: null,
        inputPayload: { path: ["_fingerprint"], equals: input.fingerprint },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { job: existing, deduplicated: true };

    const job = await this.prisma.mediaJob.create({
      data: {
        workspaceId: input.workspaceId,
        contentItemId: input.contentItemInternalId,
        operation: input.operation,
        inputPayload: { ...input.inputPayload, _fingerprint: input.fingerprint } as Prisma.InputJsonValue,
        status: "QUEUED",
        correlationId: input.correlationId,
        createdById: input.actorUserInternalId,
      },
    });

    const backgroundJob = await this.backgroundJobs.enqueue({
      workspaceId: input.workspaceId,
      jobType: JOB_TYPE_BY_OPERATION[input.operation],
      payload: { mediaJobPublicId: job.publicId },
      correlationId: input.correlationId,
      createdByUserId: input.actorUserInternalId,
    });

    const linked = await this.prisma.mediaJob.update({ where: { id: job.id }, data: { backgroundJobId: backgroundJob.id } });
    return { job: linked, deduplicated: false };
  }

  async findByPublicId(workspaceId: string, publicId: string): Promise<MediaJob | null> {
    return this.prisma.mediaJob.findFirst({ where: { workspaceId, publicId, deletedAt: null } });
  }
}
