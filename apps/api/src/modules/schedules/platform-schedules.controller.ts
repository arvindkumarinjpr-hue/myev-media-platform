import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { SessionGuard, type AuthenticatedRequest } from "../../common/guards/session.guard";
import { PlatformOwnerGuard } from "../../common/guards/platform-owner.guard";
import { PrismaService } from "../../prisma/prisma.service";
import { SchedulesService } from "./schedules.service";
import { CreateScheduleDto } from "./dto/create-schedule.dto";
import { UpdateScheduleDto } from "./dto/update-schedule.dto";
import { ListSchedulesDto } from "./dto/list-schedules.dto";
import { PreviewScheduleDto } from "./dto/preview-schedule.dto";
import { serializeSchedule } from "./schedule.serializer";

/**
 * Module 1F Milestone 7 (Scheduler Foundation), Revision 3 §3/§4/§12.
 * PlatformOwnerGuard only — deliberately independent of
 * SYSTEM_SCHEDULES_VIEW/MANAGE, which govern workspace-scoped authority
 * only and must never imply platform-level authority. Every call passes
 * `workspaceId: null` to SchedulesService, structurally identical to how
 * the workspace controller always passes its own fixed workspace id —
 * there is no request path on this controller that can ever touch a
 * workspace-owned schedule (SchedulesService's own queries scope by
 * `workspaceId: null`, verified against the DEFECT-1F-003-hardened
 * partial-index model).
 */
@Controller("api/v1/platform/schedules")
@UseGuards(SessionGuard, PlatformOwnerGuard)
export class PlatformSchedulesController {
  constructor(
    private readonly schedules: SchedulesService,
    private readonly prisma: PrismaService,
  ) {}

  // PlatformOwnerGuard validates via the caller's publicId but does not
  // attach an internal id to the request (unlike WorkspaceContextGuard's
  // WorkspaceContext) — resolved here once per call, mirroring the exact
  // pattern WorkspacesService.create() already uses for the identical
  // platform-level-action shape.
  private async resolveActorInternalId(userPublicId: string): Promise<string> {
    const user = await this.prisma.user.findFirstOrThrow({ where: { publicId: userPublicId, deletedAt: null } });
    return user.id;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: AuthenticatedRequest["user"], @Body() dto: CreateScheduleDto, @Req() req: Request) {
    const actorId = await this.resolveActorInternalId(user.sub);
    const schedule = await this.schedules.create(null, dto, actorId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Get()
  async list(@Query() query: ListSchedulesDto) {
    const schedules = await this.schedules.list(null, { enabled: query.enabled, jobType: query.jobType, limit: query.limit });
    return { data: schedules.map(serializeSchedule) };
  }

  @Get(":scheduleId")
  async get(@Param("scheduleId") scheduleId: string) {
    const schedule = await this.schedules.get(null, scheduleId);
    return { data: serializeSchedule(schedule) };
  }

  @Patch(":scheduleId")
  async update(@CurrentUser() user: AuthenticatedRequest["user"], @Param("scheduleId") scheduleId: string, @Body() dto: UpdateScheduleDto, @Req() req: Request) {
    const actorId = await this.resolveActorInternalId(user.sub);
    const schedule = await this.schedules.update(null, scheduleId, dto, actorId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Post(":scheduleId/enable")
  async enable(@CurrentUser() user: AuthenticatedRequest["user"], @Param("scheduleId") scheduleId: string, @Req() req: Request) {
    const actorId = await this.resolveActorInternalId(user.sub);
    const schedule = await this.schedules.setEnabled(null, scheduleId, true, actorId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Post(":scheduleId/disable")
  async disable(@CurrentUser() user: AuthenticatedRequest["user"], @Param("scheduleId") scheduleId: string, @Req() req: Request) {
    const actorId = await this.resolveActorInternalId(user.sub);
    const schedule = await this.schedules.setEnabled(null, scheduleId, false, actorId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Delete(":scheduleId")
  async remove(@CurrentUser() user: AuthenticatedRequest["user"], @Param("scheduleId") scheduleId: string, @Req() req: Request) {
    const actorId = await this.resolveActorInternalId(user.sub);
    const schedule = await this.schedules.softDelete(null, scheduleId, actorId, req.ip);
    return { data: serializeSchedule(schedule) };
  }

  @Get(":scheduleId/preview")
  async preview(@Param("scheduleId") scheduleId: string, @Query() query: PreviewScheduleDto) {
    const occurrences = await this.schedules.preview(null, scheduleId, query.count);
    return { data: occurrences };
  }
}
