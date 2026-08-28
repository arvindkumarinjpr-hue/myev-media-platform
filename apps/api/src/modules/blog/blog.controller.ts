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
import { BlogService } from "./blog.service";
import { BlogPipelineService, type BlogActor } from "./blog-pipeline.service";
import { CreateBlogDto } from "./dto/create-blog.dto";
import { BlogApproveDto, BlogRejectDto, BlogSubmitForReviewDto } from "./dto/blog-review.dto";

/**
 * Module 6 Phase 6.3 — Blog Pipeline API
 * (POST/GET /api/v1/workspaces/:workspaceId/blog...).
 *
 * Thin: every state-transition rule lives in BlogService /
 * BlogPipelineService. Every route is gated server-side by an EXISTING
 * frozen BLOG_ or SEO_ permission (AI_CONTENT_ROLE_PERMISSION_MATRIX_
 * V1.0.md). Because every item this controller touches is contentType
 * BLOG, a static `@RequirePermission` per route is correct (same
 * precedent as ContentScoringController); the delegated
 * `ContentItemsService` calls re-check the same permission via
 * `ContentPermissionResolver`. Workspace isolation is structural in
 * every service query.
 */
@Controller("api/v1/workspaces/:workspaceId/blog")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class BlogController {
  constructor(
    private readonly blog: BlogService,
    private readonly pipeline: BlogPipelineService,
  ) {}

  private actor(user: AuthenticatedRequest["user"], workspace: WorkspaceContext): BlogActor {
    return { userPublicId: user.sub, userInternalId: workspace.userInternalId };
  }
  private ctx(req: Request): { ipAddress?: string; correlationId: string } {
    return { ipAddress: req.ip, correlationId: (req.headers["x-request-id"] as string | undefined) ?? randomUUID() };
  }

  @Post()
  @RequirePermission(PERMISSIONS.BLOG_CREATE)
  @HttpCode(HttpStatus.ACCEPTED)
  async create(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateBlogDto, @Req() req: Request) {
    return { data: await this.blog.create(workspace.id, this.actor(user, workspace), dto, this.ctx(req)) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.BLOG_VIEW)
  async list(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: await this.blog.list(workspace.id, this.actor(user, workspace)) };
  }

  @Get(":itemId")
  @RequirePermission(PERMISSIONS.BLOG_VIEW)
  async read(@CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.pipeline.projectReadModel(workspace.id, itemId) };
  }

  @Get(":itemId/score")
  @RequirePermission(PERMISSIONS.SEO_SCORE)
  async scoreFeedback(@CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.pipeline.getScoreFeedback(workspace.id, itemId) };
  }

  // ---- Brief ----
  @Post(":itemId/brief")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async brief(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateBrief(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  @Post(":itemId/brief/approve")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.OK)
  async approveBrief(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.approveBrief(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Outline ----
  @Post(":itemId/outline")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async outline(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateOutline(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  @Post(":itemId/outline/approve")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.OK)
  async approveOutline(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.approveOutline(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Draft ----
  @Post(":itemId/draft")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async draft(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateDraft(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- SEO ----
  @Post(":itemId/seo")
  @RequirePermission(PERMISSIONS.SEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async seo(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.generateSeo(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Internal linking (seam) ----
  @Post(":itemId/internal-linking")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.OK)
  async internalLinking(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.runInternalLinking(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- QA ----
  @Post(":itemId/qa")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.OK)
  async qa(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.runQa(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Score ----
  @Post(":itemId/score")
  @RequirePermission(PERMISSIONS.SEO_SCORE)
  @HttpCode(HttpStatus.CREATED)
  async score(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.runScoring(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Human-review handoff (delegates to Module 1E) ----
  @Post(":itemId/submit-for-review")
  @RequirePermission(PERMISSIONS.BLOG_EDIT)
  @HttpCode(HttpStatus.OK)
  async submitForReview(
    @CurrentUser() u: AuthenticatedRequest["user"],
    @CurrentWorkspace() w: WorkspaceContext,
    @Param("itemId") id: string,
    @Body() dto: BlogSubmitForReviewDto,
    @Req() req: Request,
  ) {
    return { data: await this.blog.submitForReview(w.id, this.actor(u, w), id, dto, this.ctx(req)) };
  }

  @Post(":itemId/approve")
  @RequirePermission(PERMISSIONS.BLOG_APPROVE)
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() u: AuthenticatedRequest["user"],
    @CurrentWorkspace() w: WorkspaceContext,
    @Param("itemId") id: string,
    @Body() dto: BlogApproveDto,
    @Req() req: Request,
  ) {
    return { data: await this.blog.approve(w.id, this.actor(u, w), id, dto, this.ctx(req)) };
  }

  @Post(":itemId/reject")
  @RequirePermission(PERMISSIONS.BLOG_APPROVE)
  @HttpCode(HttpStatus.OK)
  async reject(
    @CurrentUser() u: AuthenticatedRequest["user"],
    @CurrentWorkspace() w: WorkspaceContext,
    @Param("itemId") id: string,
    @Body() dto: BlogRejectDto,
    @Req() req: Request,
  ) {
    return { data: await this.blog.reject(w.id, this.actor(u, w), id, dto, this.ctx(req)) };
  }
}
