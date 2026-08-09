import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { SchedulesService } from "./schedules.service";
import { CreateScheduleDto } from "./dto/create-schedule.dto";
import { UpdateScheduleDto } from "./dto/update-schedule.dto";
import { ListSchedulesDto } from "./dto/list-schedules.dto";
import { PreviewScheduleDto } from "./dto/preview-schedule.dto";
import { serializeSchedule } from "./schedule.serializer";

/**
 * Module 1F Milestone 7 (Scheduler Foundation), Revision 3 §3/§4.
 * workspaceId comes exclusively from @CurrentWorkspace() (resolved by
 * WorkspaceContextGuard from the X-Workspace-Id header/route) — the DTOs
 * this controller accepts have no workspaceId field at all, so there is
 * no request-body path that could smuggle a different scope in.
 */
@Controller("api/v1/workspaces/:workspaceId/schedules")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class WorkspaceSchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Post()
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_MANAGE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateScheduleDto, @Req() req: Request) {
    const schedule = await this.schedules.create(workspace.id, dto, workspace.userInternalId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_VIEW)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Query() query: ListSchedulesDto) {
    const schedules = await this.schedules.list(workspace.id, { enabled: query.enabled, jobType: query.jobType, limit: query.limit });
    return { data: schedules.map(serializeSchedule) };
  }

  @Get(":scheduleId")
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_VIEW)
  async get(@CurrentWorkspace() workspace: WorkspaceContext, @Param("scheduleId") scheduleId: string) {
    const schedule = await this.schedules.get(workspace.id, scheduleId);
    return { data: serializeSchedule(schedule) };
  }

  @Patch(":scheduleId")
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_MANAGE)
  async update(@CurrentWorkspace() workspace: WorkspaceContext, @Param("scheduleId") scheduleId: string, @Body() dto: UpdateScheduleDto, @Req() req: Request) {
    const schedule = await this.schedules.update(workspace.id, scheduleId, dto, workspace.userInternalId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Post(":scheduleId/enable")
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_MANAGE)
  async enable(@CurrentWorkspace() workspace: WorkspaceContext, @Param("scheduleId") scheduleId: string, @Req() req: Request) {
    const schedule = await this.schedules.setEnabled(workspace.id, scheduleId, true, workspace.userInternalId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Post(":scheduleId/disable")
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_MANAGE)
  async disable(@CurrentWorkspace() workspace: WorkspaceContext, @Param("scheduleId") scheduleId: string, @Req() req: Request) {
    const schedule = await this.schedules.setEnabled(workspace.id, scheduleId, false, workspace.userInternalId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Delete(":scheduleId")
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_MANAGE)
  async remove(@CurrentWorkspace() workspace: WorkspaceContext, @Param("scheduleId") scheduleId: string, @Req() req: Request) {
    const schedule = await this.schedules.softDelete(workspace.id, scheduleId, workspace.userInternalId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Get(":scheduleId/preview")
  @RequirePermission(PERMISSIONS.SYSTEM_SCHEDULES_VIEW)
  async preview(@CurrentWorkspace() workspace: WorkspaceContext, @Param("scheduleId") scheduleId: string, @Query() query: PreviewScheduleDto) {
    const occurrences = await this.schedules.preview(workspace.id, scheduleId, query.count);
    return { data: occurrences };
  }
}
