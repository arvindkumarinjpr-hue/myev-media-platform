import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard, type AuthenticatedRequest } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { VideoService, type VideoActor } from "./video.service";
import { VideoPipelineService } from "./video-pipeline.service";
import { CreateVideoDto } from "./dto/create-video.dto";

/**
 * Module 7 Phase 7.1 — Video Pipeline API
 * (POST/GET /api/v1/workspaces/:workspaceId/video...).
 *
 * Thin: every state-transition rule lives in VideoService /
 * VideoPipelineService. Every route is gated server-side by an EXISTING
 * frozen VIDEO_ permission (AI_CONTENT_ROLE_PERMISSION_MATRIX_V1.0.md,
 * already seeded). Because every item this controller touches is
 * contentType VIDEO, a static `@RequirePermission` per route is correct
 * (same precedent as BlogController); the delegated `ContentItemsService`
 * calls re-check the same permission via `ContentPermissionResolver`.
 * Workspace isolation is structural in every service query.
 *
 * Phase 7.1 exposed the foundation routes (create / list / detail).
 * Phase 7.2 adds the 6 text-generation routes (brief / script / script
 * approval / scene-plan / seo / thumbnail-concepts / recommendations).
 * Media / render / qa / submit-for-review / approve / reject routes
 * arrive in Phases 7.3–7.5 — no placeholder endpoints are exposed for
 * them now.
 */
@Controller("api/v1/workspaces/:workspaceId/video")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class VideoController {
  constructor(
    private readonly video: VideoService,
    private readonly pipeline: VideoPipelineService,
  ) {}

  private actor(user: AuthenticatedRequest["user"], workspace: WorkspaceContext): VideoActor {
    return { userPublicId: user.sub, userInternalId: workspace.userInternalId };
  }
  private ctx(req: Request): { ipAddress?: string; correlationId: string } {
    return { ipAddress: req.ip, correlationId: (req.headers["x-request-id"] as string | undefined) ?? randomUUID() };
  }

  @Post()
  @RequirePermission(PERMISSIONS.VIDEO_CREATE)
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateVideoDto, @Req() req: Request) {
    return { data: await this.video.create(workspace.id, this.actor(user, workspace), dto, this.ctx(req)) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async list(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: await this.video.list(workspace.id, this.actor(user, workspace)) };
  }

  @Get(":itemId")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async read(@CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.pipeline.projectReadModel(workspace.id, itemId) };
  }

  // ---- Brief ----
  @Post(":itemId/brief")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async brief(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateBrief(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Script ----
  @Post(":itemId/script")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async script(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateScript(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Script approval — Quality Gate #1 ----
  @Post(":itemId/script/approve")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async approveScript(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.approveScript(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Scene planning ----
  @Post(":itemId/scene-plan")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async scenePlan(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateScenePlan(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- SEO — Quality Gate #6 ----
  @Post(":itemId/seo")
  @RequirePermission(PERMISSIONS.SEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async seo(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateSeo(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Thumbnail concepts (advisory) ----
  @Post(":itemId/thumbnail-concepts")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async thumbnailConcepts(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateThumbnailConcepts(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Recommendations (advisory) ----
  @Post(":itemId/recommendations")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async recommendations(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateRecommendations(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }
}
