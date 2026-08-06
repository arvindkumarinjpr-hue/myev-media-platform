import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import type { ContentSeries } from "../../../generated/prisma";
import { ContentSeriesService } from "./content-series.service";
import { CreateContentSeriesDto } from "./dto/create-content-series.dto";
import { UpdateContentSeriesDto } from "./dto/update-content-series.dto";

function serializeSeries(series: ContentSeries) {
  return { publicId: series.publicId, projectId: series.projectId, name: series.name, createdAt: series.createdAt, updatedAt: series.updatedAt };
}

@Controller("api/v1/workspaces/:workspaceId/content-series")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class ContentSeriesController {
  constructor(private readonly contentSeries: ContentSeriesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.CONTENT_SERIES_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateContentSeriesDto, @Req() req: Request) {
    const series = await this.contentSeries.create(workspace, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: serializeSeries(series) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.CONTENT_SERIES_MANAGE)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Query("projectId") projectId?: string) {
    const series = await this.contentSeries.list(workspace.id, { projectId });
    return { data: series.map(serializeSeries) };
  }

  @Get(":seriesId")
  @RequirePermission(PERMISSIONS.CONTENT_SERIES_MANAGE)
  async findOne(@CurrentWorkspace() workspace: WorkspaceContext, @Param("seriesId") seriesId: string) {
    const series = await this.contentSeries.findOne(workspace.id, seriesId);
    return { data: serializeSeries(series) };
  }

  @Patch(":seriesId")
  @RequirePermission(PERMISSIONS.CONTENT_SERIES_MANAGE)
  async update(
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("seriesId") seriesId: string,
    @Body() dto: UpdateContentSeriesDto,
    @Req() req: Request,
  ) {
    const series = await this.contentSeries.update(workspace.id, seriesId, workspace.userInternalId, dto, { ipAddress: req.ip });
    return { data: serializeSeries(series) };
  }

  @Delete(":seriesId")
  @RequirePermission(PERMISSIONS.CONTENT_SERIES_MANAGE)
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentWorkspace() workspace: WorkspaceContext, @Param("seriesId") seriesId: string, @Req() req: Request) {
    await this.contentSeries.remove(workspace.id, seriesId, workspace.userInternalId, { ipAddress: req.ip });
    return { data: { success: true } };
  }
}
