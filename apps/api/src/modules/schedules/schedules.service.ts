import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { InvalidCronExpressionError, InvalidScheduleTimezoneError, computeNextOccurrence, computeNextOccurrences, validateCronExpression, validateTimezone, type QueueRegistry } from "@myev/shared";
import { Prisma, type ScheduledJob } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { QUEUE_REGISTRY } from "../background-jobs/queue-registry.module";
import type { CreateScheduleDto } from "./dto/create-schedule.dto";
import type { UpdateScheduleDto } from "./dto/update-schedule.dto";

const DEFAULT_TIMEZONE = "UTC";

/**
 * Module 1F Milestone 7 (Scheduler Foundation), Revision 3. Backs both
 * route surfaces (workspace-scoped and platform-level) — every method
 * takes `workspaceId: string | null` exactly like BackgroundJobsService's
 * own EnqueueJobInput does, and every query is scoped by it
 * (`workspaceId: null` is translated by Prisma to `IS NULL`, verified
 * empirically this same engagement during DEFECT-1F-003). The two
 * controllers differ only in guard and route prefix — never in scoping
 * logic, so there is exactly one place workspace/platform isolation can
 * be gotten wrong, not two.
 *
 * Never dispatches anything itself — that is exclusively
 * SchedulerTickManager's job (apps/worker). This service only manages
 * the `scheduled_jobs` row: its definition, its enabled state, and its
 * cached `nextRunAt`.
 */
@Injectable()
export class SchedulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(QUEUE_REGISTRY) private readonly registry: QueueRegistry,
  ) {}

  private validateCronAndTimezone(cronExpression: string, timezone: string): void {
    try {
      validateCronExpression(cronExpression);
    } catch (error) {
      if (error instanceof InvalidCronExpressionError) {
        throw new BadRequestException({ code: "INVALID_CRON_EXPRESSION", message: error.message });
      }
      throw error;
    }
    try {
      validateTimezone(timezone);
    } catch (error) {
      if (error instanceof InvalidScheduleTimezoneError) {
        throw new BadRequestException({ code: "INVALID_SCHEDULE_TIMEZONE", message: error.message });
      }
      throw error;
    }
  }

  async create(workspaceId: string | null, dto: CreateScheduleDto, actorUserId: string | null, ipAddress?: string): Promise<ScheduledJob> {
    const manifest = this.registry.getManifest(dto.jobType);
    if (!manifest) {
      throw new BadRequestException({ code: "JOB_TYPE_UNKNOWN", message: `"${dto.jobType}" is not a registered job type.` });
    }

    const payload = plainToInstance(manifest.payloadDto, dto.payload);
    const validationErrors = await validate(payload);
    if (validationErrors.length > 0) {
      throw new BadRequestException({
        code: "JOB_PAYLOAD_INVALID",
        message: "Schedule payload failed validation.",
        details: validationErrors.map((error) => error.toString()),
      });
    }

    const timezone = dto.timezone ?? DEFAULT_TIMEZONE;
    this.validateCronAndTimezone(dto.cronExpression, timezone);

    const nextRunAt = computeNextOccurrence(dto.cronExpression, timezone, new Date());

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.scheduledJob.create({
        data: {
          workspaceId,
          jobType: dto.jobType,
          payloadMetadata: payload as unknown as Prisma.InputJsonValue,
          cronExpression: dto.cronExpression,
          timezone,
          nextRunAt,
          createdById: actorUserId,
          updatedById: actorUserId,
        },
      });
      await this.audit.recordWithinTransaction(tx, {
        action: "SCHEDULE_CREATED",
        actorUserId,
        workspaceId,
        entityType: "scheduled_job",
        entityId: created.publicId,
        ipAddress,
      });
      return created;
    });
  }

  async list(workspaceId: string | null, filters: { enabled?: boolean; jobType?: string; limit: number }): Promise<ScheduledJob[]> {
    return this.prisma.scheduledJob.findMany({
      where: { workspaceId, deletedAt: null, enabled: filters.enabled, jobType: filters.jobType },
      orderBy: { createdAt: "desc" },
      take: filters.limit,
    });
  }

  async get(workspaceId: string | null, schedulePublicId: string): Promise<ScheduledJob> {
    const schedule = await this.prisma.scheduledJob.findFirst({
      where: { publicId: schedulePublicId, workspaceId, deletedAt: null },
    });
    if (!schedule) {
      throw new NotFoundException({ code: "SCHEDULE_NOT_FOUND", message: "Schedule not found." });
    }
    return schedule;
  }

  async update(workspaceId: string | null, schedulePublicId: string, dto: UpdateScheduleDto, actorUserId: string | null, ipAddress?: string): Promise<ScheduledJob> {
    const existing = await this.get(workspaceId, schedulePublicId);

    let payload: object | undefined;
    if (dto.payload !== undefined) {
      const manifest = this.registry.getManifest(existing.jobType);
      if (!manifest) {
        // Structurally the same "orphaned schedule" scenario §7 describes
        // for the scan — surfaced here as a clean 400 instead, since this
        // path has a caller to report it to.
        throw new BadRequestException({ code: "JOB_TYPE_UNKNOWN", message: `"${existing.jobType}" is no longer a registered job type.` });
      }
      const instance = plainToInstance(manifest.payloadDto, dto.payload);
      const validationErrors = await validate(instance);
      if (validationErrors.length > 0) {
        throw new BadRequestException({
          code: "JOB_PAYLOAD_INVALID",
          message: "Schedule payload failed validation.",
          details: validationErrors.map((error) => error.toString()),
        });
      }
      payload = instance;
    }

    const cronExpression = dto.cronExpression ?? existing.cronExpression;
    const timezone = dto.timezone ?? existing.timezone;
    const definitionChanged = dto.cronExpression !== undefined || dto.timezone !== undefined;
    if (definitionChanged) {
      this.validateCronAndTimezone(cronExpression, timezone);
    }
    const nextRunAt = definitionChanged ? computeNextOccurrence(cronExpression, timezone, new Date()) : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.scheduledJob.updateMany({
        where: { id: existing.id, version: dto.version },
        data: {
          payloadMetadata: payload !== undefined ? (payload as unknown as Prisma.InputJsonValue) : undefined,
          cronExpression: dto.cronExpression,
          timezone: dto.timezone,
          nextRunAt,
          version: { increment: 1 },
          updatedById: actorUserId,
          // A successful, genuine definition update clears any stale
          // auto-disable error metadata (Revision 3 §7) — Enable alone
          // does not.
          lastErrorCode: null,
          lastErrorMessageSafe: null,
        },
      });
      if (result.count === 0) return null;
      await this.audit.recordWithinTransaction(tx, {
        action: "SCHEDULE_UPDATED",
        actorUserId,
        workspaceId,
        entityType: "scheduled_job",
        entityId: existing.publicId,
        ipAddress,
      });
      return true;
    });

    if (!updated) {
      throw new ConflictException({ code: "SCHEDULE_VERSION_CONFLICT", message: "This schedule was modified by another request. Reload and try again." });
    }

    return this.get(workspaceId, schedulePublicId);
  }

  async setEnabled(workspaceId: string | null, schedulePublicId: string, enabled: boolean, actorUserId: string | null, ipAddress?: string): Promise<ScheduledJob> {
    const existing = await this.get(workspaceId, schedulePublicId);
    if (existing.enabled === enabled) {
      // Idempotent no-op — repeating the same enable/disable is not an
      // error and not a duplicate audit entry (Revision 3 §4).
      return existing;
    }

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.scheduledJob.updateMany({
        where: { id: existing.id, enabled: !enabled },
        data: { enabled, version: { increment: 1 }, updatedById: actorUserId },
      });
      if (result.count === 0) return;
      await this.audit.recordWithinTransaction(tx, {
        action: enabled ? "SCHEDULE_ENABLED" : "SCHEDULE_DISABLED",
        actorUserId,
        workspaceId,
        entityType: "scheduled_job",
        entityId: existing.publicId,
        ipAddress,
      });
    });

    // Whether this call won the race or another concurrent identical
    // request did, the desired end state is what matters — re-fetch and
    // return current reality rather than erroring on a benign race
    // between two callers wanting the same outcome.
    return this.get(workspaceId, schedulePublicId);
  }

  async softDelete(workspaceId: string | null, schedulePublicId: string, actorUserId: string | null, ipAddress?: string): Promise<ScheduledJob> {
    const existing = await this.get(workspaceId, schedulePublicId);

    // Returned directly from the transaction, never re-fetched through
    // get() afterward — get() filters WHERE deletedAt: null, so it could
    // never find the row this method itself just soft-deleted (found via
    // this file's own e2e suite: the delete endpoint returned 404 on its
    // own successful deletion).
    const deleted = await this.prisma.$transaction(async (tx) => {
      const result = await tx.scheduledJob.updateMany({
        where: { id: existing.id, deletedAt: null },
        data: { deletedAt: new Date(), version: { increment: 1 }, updatedById: actorUserId },
      });
      if (result.count === 0) return existing;
      await this.audit.recordWithinTransaction(tx, {
        action: "SCHEDULE_DELETED",
        actorUserId,
        workspaceId,
        entityType: "scheduled_job",
        entityId: existing.publicId,
        ipAddress,
      });
      return tx.scheduledJob.findUniqueOrThrow({ where: { id: existing.id } });
    });

    return deleted;
  }

  async preview(workspaceId: string | null, schedulePublicId: string, count: number): Promise<{ utc: string; local: string }[]> {
    const schedule = await this.get(workspaceId, schedulePublicId);
    const occurrences = computeNextOccurrences(schedule.cronExpression, schedule.timezone, new Date(), count);
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone, dateStyle: "medium", timeStyle: "long" });
    return occurrences.map((date) => ({ utc: date.toISOString(), local: formatter.format(date) }));
  }
}
