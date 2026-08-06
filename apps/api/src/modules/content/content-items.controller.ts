import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import type { AuthenticatedRequest } from "../../common/guards/session.guard";
import type { ContentItemStatus } from "../../../generated/prisma";
import { ContentItemsService, type ContentActor, type ContentItemWithPublicRefs } from "./content-items.service";
import { CreateContentItemDto } from "./dto/create-content-item.dto";
import { UpdateContentItemDto } from "./dto/update-content-item.dto";
import { CreateContentVersionDto } from "./dto/create-content-version.dto";
import { SubmitForReviewDto, ApproveContentDto, RejectContentDto } from "./dto/review-action.dto";
import { UpdateContentItemProjectDto } from "./dto/update-content-item-project.dto";
import { UpdateContentItemSeriesDto } from "./dto/update-content-item-series.dto";
import { UpdateContentItemFeaturedMediaDto } from "./dto/update-content-item-featured-media.dto";

// projectId/seriesId/featuredMediaAssetId below are each the related
// resource's PUBLIC id, resolved via the `project`/`series`/
// `featuredMediaAsset` relations every ContentItemsService method
// includes — never item.projectId etc. directly, which are internal FKs
// and must never reach a client.
function serializeItem(item: ContentItemWithPublicRefs) {
  return {
    publicId: item.publicId,
    projectId: item.project?.publicId ?? null,
    contentType: item.contentType,
    title: item.title,
    seriesId: item.series?.publicId ?? null,
    featuredMediaAssetId: item.featuredMediaAsset?.publicId ?? null,
    status: item.status,
    archivedFromStatus: item.archivedFromStatus,
    metadata: item.metadata,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    archivedAt: item.archivedAt,
  };
}

/**
 * Deliberately no PermissionGuard/@RequirePermission here (Module 1E
 * Engineering Plan §6): which permission a route needs depends on the
 * request body's or resolved row's actual contentType, known only after
 * ContentItemsService reads it — a handler-level decorator has no access
 * to that. SessionGuard + WorkspaceContextGuard establish who the caller
 * is and which workspace they're acting in; every authorization decision
 * from there happens inside the service via ContentPermissionResolver.
 */
@Controller("api/v1/workspaces/:workspaceId/content-items")
@UseGuards(SessionGuard, WorkspaceContextGuard)
export class ContentItemsController {
  constructor(private readonly contentItems: ContentItemsService) {}

  private actor(user: AuthenticatedRequest["user"], workspace: WorkspaceContext): ContentActor {
    return { publicId: user.sub, internalId: workspace.userInternalId };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Body() dto: CreateContentItemDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.create(workspace, this.actor(user, workspace), dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query("projectId") projectId?: string,
    @Query("seriesId") seriesId?: string,
    @Query("status") status?: ContentItemStatus,
    @Query("contentType") contentType?: string,
  ) {
    const items = await this.contentItems.list(workspace, this.actor(user, workspace), { projectId, seriesId, status, contentType });
    return { data: items.map(serializeItem) };
  }

  @Get(":itemId")
  async findOne(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    const item = await this.contentItems.findOne(workspace, this.actor(user, workspace), itemId);
    return { data: serializeItem(item) };
  }

  @Patch(":itemId")
  async update(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: UpdateContentItemDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.update(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Delete(":itemId")
  @HttpCode(HttpStatus.OK)
  async remove(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Req() req: Request) {
    await this.contentItems.remove(workspace, this.actor(user, workspace), itemId, { ipAddress: req.ip });
    return { data: { success: true } };
  }

  @Post(":itemId/versions")
  @HttpCode(HttpStatus.CREATED)
  async createVersion(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: CreateContentVersionDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.createVersion(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Post(":itemId/start")
  @HttpCode(HttpStatus.OK)
  async start(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Req() req: Request) {
    const item = await this.contentItems.start(workspace, this.actor(user, workspace), itemId, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Post(":itemId/submit-for-review")
  @HttpCode(HttpStatus.OK)
  async submitForReview(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: SubmitForReviewDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.submitForReview(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Post(":itemId/approve")
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: ApproveContentDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.approve(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Post(":itemId/reject")
  @HttpCode(HttpStatus.OK)
  async reject(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: RejectContentDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.reject(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Post(":itemId/archive")
  @HttpCode(HttpStatus.OK)
  async archive(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Req() req: Request) {
    const item = await this.contentItems.archive(workspace, this.actor(user, workspace), itemId, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Post(":itemId/restore")
  @HttpCode(HttpStatus.OK)
  async restore(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Req() req: Request) {
    const item = await this.contentItems.restore(workspace, this.actor(user, workspace), itemId, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Patch(":itemId/project")
  async updateProject(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: UpdateContentItemProjectDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.updateProject(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Patch(":itemId/series")
  async assignSeries(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: UpdateContentItemSeriesDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.assignSeries(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }

  @Patch(":itemId/featured-media")
  async setFeaturedMedia(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: UpdateContentItemFeaturedMediaDto,
    @Req() req: Request,
  ) {
    const item = await this.contentItems.setFeaturedMedia(workspace, this.actor(user, workspace), itemId, dto, { ipAddress: req.ip });
    return { data: serializeItem(item) };
  }
}
