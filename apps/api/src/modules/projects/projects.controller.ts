import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { ProjectsService } from "./projects.service";
import { CreateProjectDto } from "./dto/create-project.dto";
import { UpdateProjectDto } from "./dto/update-project.dto";

@Controller("api/v1/workspaces/:workspaceId/projects")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @RequirePermission(PERMISSIONS.PROJECT_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateProjectDto, @Req() req: Request) {
    const project = await this.projectsService.create(workspace.id, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: { publicId: project.publicId, name: project.name, slug: project.slug, status: project.status } };
  }

  @Get()
  @RequirePermission(PERMISSIONS.PROJECT_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext) {
    const projects = await this.projectsService.list(workspace.id);
    return { data: projects.map((p) => ({ publicId: p.publicId, name: p.name, slug: p.slug, status: p.status, knowledgePackPublicId: p.activeKnowledgePack?.publicId ?? null })) };
  }

  @Get(":projectId")
  @RequirePermission(PERMISSIONS.PROJECT_VIEW)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("projectId") projectId: string) {
    const project = await this.projectsService.findOne(workspace.id, projectId);
    return { data: { publicId: project.publicId, name: project.name, slug: project.slug, status: project.status, knowledgePackPublicId: project.activeKnowledgePack?.publicId ?? null } };
  }

  @Patch(":projectId")
  @RequirePermission(PERMISSIONS.PROJECT_UPDATE)
  async update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("projectId") projectId: string,
    @Body() dto: UpdateProjectDto,
    @Req() req: Request,
  ) {
    const project = await this.projectsService.update(workspace.id, projectId, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: { publicId: project.publicId, name: project.name, slug: project.slug, knowledgePackPublicId: project.activeKnowledgePack?.publicId ?? null } };
  }

  @Post(":projectId/archive")
  @RequirePermission(PERMISSIONS.PROJECT_UPDATE)
  @HttpCode(HttpStatus.OK)
  async archive(@CurrentWorkspace() workspace: WorkspaceContext, @Param("projectId") projectId: string, @Req() req: Request) {
    await this.projectsService.archive(workspace.id, projectId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Post(":projectId/restore")
  @RequirePermission(PERMISSIONS.PROJECT_UPDATE)
  @HttpCode(HttpStatus.OK)
  async restore(@CurrentWorkspace() workspace: WorkspaceContext, @Param("projectId") projectId: string, @Req() req: Request) {
    await this.projectsService.restore(workspace.id, projectId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }
}
