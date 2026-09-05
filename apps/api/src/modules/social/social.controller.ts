import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { SessionGuard, type AuthenticatedRequest } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import type { ContentActor } from "../content/content-items.service";
import { ApproveContentDto, RejectContentDto, SubmitForReviewDto } from "../content/dto/review-action.dto";
import { SocialGenerationService } from "./social-generation.service";
import { SocialService } from "./social.service";
import { CreateSocialPostDto } from "./dto/create-social-post.dto";
import { RegenerateSocialPostDto } from "./dto/regenerate-social-post.dto";
import { EditSocialPostDto } from "./dto/edit-social-post.dto";

/**
 * Module 10 Phase 10.2/10.3 — Social Media API. Every route is gated
 * server-side by a static @RequirePermission (SOCIAL_VIEW/EDIT/APPROVE) —
 * correct here exactly like BlogController's own identical choice, since
 * every item this controller ever touches is contentType SOCIAL_POST.
 * SocialService/SocialGenerationService each re-verify contentType ===
 * "SOCIAL_POST" on every single-item route (see their own doc comments)
 * so this surface can never act on an unrelated Blog/Video item.
 */
@Controller("api/v1/workspaces/:workspaceId/social-posts")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class SocialController {
  constructor(
    private readonly socialGeneration: SocialGenerationService,
    private readonly social: SocialService,
  ) {}

  private actor(user: AuthenticatedRequest["user"], workspace: WorkspaceContext): ContentActor {
    return { publicId: user.sub, internalId: workspace.userInternalId };
  }

  private ctx(req: Request): { ipAddress?: string; correlationId: string } {
    return { ipAddress: req.ip, correlationId: (req.headers["x-request-id"] as string | undefined) ?? randomUUID() };
  }

  @Post()
  @RequirePermission(PERMISSIONS.SOCIAL_CREATE)
  @HttpCode(HttpStatus.CREATED)
  async create(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreateSocialPostDto, @Req() req: Request) {
    return { data: await this.socialGeneration.createFromSource({ id: workspace.id }, this.actor(user, workspace), dto, this.ctx(req)) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.SOCIAL_VIEW)
  async list(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Query("platform") platform?: string,
    @Query("status") status?: string,
    @Query("sourceContentItemId") sourceContentItemId?: string,
  ) {
    return { data: await this.social.list({ id: workspace.id }, this.actor(user, workspace), { platform, status, sourceContentItemId }) };
  }

  @Get(":itemId")
  @RequirePermission(PERMISSIONS.SOCIAL_VIEW)
  async findOne(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.social.findOne({ id: workspace.id }, this.actor(user, workspace), itemId) };
  }

  @Get(":itemId/versions")
  @RequirePermission(PERMISSIONS.SOCIAL_VIEW)
  async listVersions(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.social.listVersions({ id: workspace.id }, this.actor(user, workspace), itemId) };
  }

  @Patch(":itemId")
  @RequirePermission(PERMISSIONS.SOCIAL_EDIT)
  async edit(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Body() dto: EditSocialPostDto, @Req() req: Request) {
    return { data: await this.social.edit({ id: workspace.id }, this.actor(user, workspace), itemId, dto, this.ctx(req)) };
  }

  @Post(":itemId/regenerate")
  @RequirePermission(PERMISSIONS.SOCIAL_EDIT)
  @HttpCode(HttpStatus.OK)
  async regenerate(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: RegenerateSocialPostDto,
    @Req() req: Request,
  ) {
    return { data: await this.socialGeneration.regenerate({ id: workspace.id }, this.actor(user, workspace), itemId, dto, this.ctx(req)) };
  }

  @Post(":itemId/submit-for-review")
  @RequirePermission(PERMISSIONS.SOCIAL_EDIT)
  @HttpCode(HttpStatus.OK)
  async submitForReview(
    @CurrentUser() user: AuthenticatedRequest["user"],
    @CurrentWorkspace() workspace: WorkspaceContext,
    @Param("itemId") itemId: string,
    @Body() dto: SubmitForReviewDto,
    @Req() req: Request,
  ) {
    return { data: await this.social.submitForReview({ id: workspace.id }, this.actor(user, workspace), itemId, dto, this.ctx(req)) };
  }

  @Post(":itemId/approve")
  @RequirePermission(PERMISSIONS.SOCIAL_APPROVE)
  @HttpCode(HttpStatus.OK)
  async approve(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Body() dto: ApproveContentDto, @Req() req: Request) {
    return { data: await this.social.approve({ id: workspace.id }, this.actor(user, workspace), itemId, dto, this.ctx(req)) };
  }

  @Post(":itemId/reject")
  @RequirePermission(PERMISSIONS.SOCIAL_APPROVE)
  @HttpCode(HttpStatus.OK)
  async reject(@CurrentUser() user: AuthenticatedRequest["user"], @CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string, @Body() dto: RejectContentDto, @Req() req: Request) {
    return { data: await this.social.reject({ id: workspace.id }, this.actor(user, workspace), itemId, dto, this.ctx(req)) };
  }
}
