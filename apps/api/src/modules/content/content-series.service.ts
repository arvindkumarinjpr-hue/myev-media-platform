import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, type ContentSeries } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import type { CreateContentSeriesDto } from "./dto/create-content-series.dto";
import type { UpdateContentSeriesDto } from "./dto/update-content-series.dto";

interface RequestContext {
  ipAddress?: string;
}

interface LockedSeriesRow {
  id: string;
  publicId: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const CONTENT_SERIES_COLUMNS = `
  id,
  public_id AS "publicId",
  workspace_id AS "workspaceId",
  project_id AS "projectId",
  name,
  created_by AS "createdById",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt"
`;

@Injectable()
export class ContentSeriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(workspace: { id: string }, actorUserId: string, dto: CreateContentSeriesDto, context: RequestContext): Promise<ContentSeries> {
    let projectInternalId: string | null = null;
    if (dto.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: dto.projectId, workspaceId: workspace.id, deletedAt: null } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectInternalId = project.id;
    }

    const created = await this.prisma.contentSeries.create({
      data: { workspaceId: workspace.id, projectId: projectInternalId, name: dto.name, createdById: actorUserId },
    });

    await this.audit.record({
      action: "CONTENT_SERIES_CREATED",
      actorUserId,
      workspaceId: workspace.id,
      entityType: "content_series",
      entityId: created.publicId,
      ipAddress: context.ipAddress,
    });

    return created;
  }

  async list(workspaceId: string, filters: { projectId?: string }): Promise<ContentSeries[]> {
    let projectInternalId: string | undefined;
    if (filters.projectId) {
      const project = await this.prisma.project.findFirst({ where: { publicId: filters.projectId, workspaceId } });
      if (!project) throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
      projectInternalId = project.id;
    }
    return this.prisma.contentSeries.findMany({
      where: { workspaceId, deletedAt: null, ...(projectInternalId ? { projectId: projectInternalId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  async findOne(workspaceId: string, seriesPublicId: string): Promise<ContentSeries> {
    const series = await this.prisma.contentSeries.findFirst({ where: { publicId: seriesPublicId, workspaceId, deletedAt: null } });
    if (!series) throw new NotFoundException({ code: "CONTENT_SERIES_NOT_FOUND", message: "Content series not found." });
    return series;
  }

  async update(workspaceId: string, seriesPublicId: string, actorUserId: string, dto: UpdateContentSeriesDto, context: RequestContext): Promise<ContentSeries> {
    const series = await this.findOne(workspaceId, seriesPublicId);
    const updated = await this.prisma.contentSeries.update({ where: { id: series.id }, data: { name: dto.name } });

    await this.audit.record({
      action: "CONTENT_SERIES_UPDATED",
      actorUserId,
      workspaceId,
      entityType: "content_series",
      entityId: series.publicId,
      ipAddress: context.ipAddress,
      beforeState: { name: series.name },
      afterState: { name: updated.name },
    });

    return updated;
  }

  /**
   * Locked deletion (Module 1E Engineering Plan §5 final correction round,
   * "Serialize Series Assignment and Deletion"): locks ONLY this series
   * row, by id — the same row every series-assignment/reassignment on a
   * content item locks too (ContentItemsService), so the two operations
   * always serialize against each other through Postgres row-lock
   * ordering rather than racing. RESTRICT-style, per the schema's model
   * comment: any non-DELETED content item still referencing this series
   * blocks deletion — never silently orphans a live item's seriesId.
   */
  async remove(workspaceId: string, seriesPublicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const lookup = await this.findOne(workspaceId, seriesPublicId);

    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<LockedSeriesRow[]>`
        SELECT ${Prisma.raw(CONTENT_SERIES_COLUMNS)} FROM content_series WHERE id = ${lookup.id}::uuid FOR UPDATE
      `;
      if (!locked || locked.deletedAt !== null) {
        // Lost the race — a concurrent delete already removed it between
        // findOne() and lock acquisition. Enumeration-safe: identical to
        // "never existed" from the caller's perspective.
        throw new NotFoundException({ code: "CONTENT_SERIES_NOT_FOUND", message: "Content series not found." });
      }

      const referencingCount = await tx.contentItem.count({ where: { seriesId: locked.id, status: { not: "DELETED" } } });
      if (referencingCount > 0) {
        throw new ConflictException({
          code: "CONTENT_SERIES_NOT_EMPTY",
          message: "Cannot delete a content series while content items still reference it. Unassign or delete those items first.",
        });
      }

      await tx.contentSeries.update({ where: { id: locked.id }, data: { deletedAt: new Date() } });
      await this.audit.recordWithinTransaction(tx, {
        action: "CONTENT_SERIES_DELETED",
        actorUserId,
        workspaceId,
        entityType: "content_series",
        entityId: locked.publicId,
        ipAddress: context.ipAddress,
      });
    });
  }
}
