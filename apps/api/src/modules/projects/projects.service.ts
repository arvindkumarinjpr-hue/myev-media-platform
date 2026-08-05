import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Project } from "../../../generated/prisma";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { SlugReservationService } from "../workspaces/slug-reservation.service";
import type { CreateProjectDto } from "./dto/create-project.dto";
import type { UpdateProjectDto } from "./dto/update-project.dto";

interface RequestContext {
  ipAddress?: string;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly slugReservationService: SlugReservationService,
    private readonly audit: AuditService,
  ) {}

  async create(workspaceId: string, actorUserId: string, dto: CreateProjectDto, context: RequestContext): Promise<Project> {
    return this.prisma.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: { workspaceId, name: dto.name, slug: dto.slug, ownerId: actorUserId, createdById: actorUserId },
      });
      // Same pattern as workspace creation (Module 1C Engineering Plan
      // §1): resource insert, then reservation insert, same transaction —
      // the reservation's own UNIQUE(workspace_id, slug) is the real
      // collision check.
      await this.slugReservationService.reserveProjectSlug(tx, workspaceId, project.id, dto.slug);

      await this.audit.recordWithinTransaction(tx, {
        action: "PROJECT_CREATED",
        actorUserId,
        workspaceId,
        entityType: "project",
        entityId: project.publicId,
        ipAddress: context.ipAddress,
      });

      return project;
    });
  }

  async list(workspaceId: string): Promise<Project[]> {
    return this.prisma.project.findMany({ where: { workspaceId, deletedAt: null }, orderBy: { createdAt: "asc" } });
  }

  async findOne(workspaceId: string, projectPublicId: string): Promise<Project> {
    const project = await this.prisma.project.findFirst({ where: { workspaceId, publicId: projectPublicId, deletedAt: null } });
    if (!project) {
      // Cross-workspace / non-existent probe — enumeration-safe, same rule
      // as WorkspaceContextGuard (Module 1C Engineering Plan §2.B).
      throw new NotFoundException({ code: "PROJECT_NOT_FOUND", message: "Project not found." });
    }
    return project;
  }

  async update(workspaceId: string, projectPublicId: string, actorUserId: string, dto: UpdateProjectDto, context: RequestContext): Promise<Project> {
    const project = await this.findOne(workspaceId, projectPublicId);
    const beforeState = { name: project.name, slug: project.slug };

    return this.prisma.$transaction(async (tx) => {
      if (dto.slug && dto.slug !== project.slug) {
        // Rename sequence identical to WorkspacesService.updateSettings:
        // new reservation first (the real enforcement point), then the
        // resource update. The old reservation is left untouched.
        await this.slugReservationService.reserveProjectSlug(tx, workspaceId, project.id, dto.slug);
      }

      const updated = await tx.project.update({
        where: { id: project.id },
        data: { ...(dto.name ? { name: dto.name } : {}), ...(dto.slug ? { slug: dto.slug } : {}) },
      });

      await this.audit.recordWithinTransaction(tx, {
        action: "PROJECT_UPDATED",
        actorUserId,
        workspaceId,
        entityType: "project",
        entityId: project.publicId,
        ipAddress: context.ipAddress,
        beforeState,
        afterState: { name: updated.name, slug: updated.slug },
      });

      return updated;
    });
  }

  async archive(workspaceId: string, projectPublicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const project = await this.findOne(workspaceId, projectPublicId);
    if (project.status === "ARCHIVED") {
      throw new ConflictException({ code: "PROJECT_ALREADY_ARCHIVED", message: "Project is already archived." });
    }
    await this.prisma.project.update({ where: { id: project.id }, data: { status: "ARCHIVED", archivedAt: new Date() } });
    await this.audit.record({
      action: "PROJECT_ARCHIVED",
      actorUserId,
      workspaceId,
      entityType: "project",
      entityId: project.publicId,
      ipAddress: context.ipAddress,
    });
  }

  async restore(workspaceId: string, projectPublicId: string, actorUserId: string, context: RequestContext): Promise<void> {
    const project = await this.findOne(workspaceId, projectPublicId);
    if (project.status !== "ARCHIVED") {
      throw new ConflictException({ code: "PROJECT_NOT_ARCHIVED", message: "Project is not archived." });
    }
    await this.prisma.project.update({ where: { id: project.id }, data: { status: "ACTIVE", archivedAt: null } });
    await this.audit.record({
      action: "PROJECT_RESTORED",
      actorUserId,
      workspaceId,
      entityType: "project",
      entityId: project.publicId,
      ipAddress: context.ipAddress,
    });
  }
}
