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
import { VideoMediaService } from "./video-media.service";
import { VideoRenderService } from "./video-render.service";
import { VideoQaService } from "./video-qa.service";
import { CreateVideoDto } from "./dto/create-video.dto";
import { VideoApproveDto, VideoRejectDto, VideoSubmitForReviewDto } from "./dto/video-review.dto";
import { VideoAttachSceneAssetDto, VideoGenerateVoiceDto, VideoSelectThumbnailConceptDto } from "./dto/video-media.dto";

/**
 * Module 7 Phase 7.1–7.3 — Video Pipeline API
 * (POST/GET /api/v1/workspaces/:workspaceId/video...).
 *
 * Thin: every state-transition rule lives in VideoService /
 * VideoPipelineService. Every route is gated server-side by an EXISTING
 * frozen VIDEO_/SEO_ permission (AI_CONTENT_ROLE_PERMISSION_MATRIX_
 * V1.0.md, already seeded). Because every item this controller touches
 * is contentType VIDEO, a static `@RequirePermission` per route is
 * correct (same precedent as BlogController); the delegated
 * `ContentItemsService` calls re-check the same permission via
 * `ContentPermissionResolver`. Workspace isolation is structural in
 * every service query.
 *
 * Phase 7.1: foundation routes (create / list / detail).
 * Phase 7.2: the 6 text-generation routes (brief / script / script
 * approval / scene-plan / seo / thumbnail-concepts / recommendations).
 * Phase 7.3: score (GET/POST) + submit-for-review + approve/reject
 * (Gate #7 Human Approval). Media / render / qa routes arrive in
 * Phases 7.4–7.5 — no placeholder endpoints are exposed for them now.
 */
@Controller("api/v1/workspaces/:workspaceId/video")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class VideoController {
  constructor(
    private readonly video: VideoService,
    private readonly pipeline: VideoPipelineService,
    private readonly media: VideoMediaService,
    private readonly render: VideoRenderService,
    private readonly qa: VideoQaService,
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

  // ---- Score (Video Score + Thumbnail Score) ----
  @Get(":itemId/score")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async scoreFeedback(@CurrentWorkspace() workspace: WorkspaceContext, @Param("itemId") itemId: string) {
    return { data: await this.pipeline.getScoreFeedback(workspace.id, itemId) };
  }

  @Post(":itemId/score")
  @RequirePermission(PERMISSIONS.SEO_SCORE)
  @HttpCode(HttpStatus.CREATED)
  async score(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.runScore(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Phase 7.4: Asset stage — per-scene resolution + Gate #2 ----
  @Get(":itemId/assets")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async assets(@CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string) {
    return { data: await this.media.listAssets(w.id, id) };
  }

  @Post(":itemId/assets/scenes/:sceneId/generate-image")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async generateSceneImage(
    @CurrentUser() u: AuthenticatedRequest["user"],
    @CurrentWorkspace() w: WorkspaceContext,
    @Param("itemId") id: string,
    @Param("sceneId") sceneId: string,
    @Req() req: Request,
  ) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.media.generateSceneImage(w.id, this.actor(u, w), id, sceneId, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  @Post(":itemId/assets/scenes/:sceneId/attach")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async attachSceneAsset(
    @CurrentUser() u: AuthenticatedRequest["user"],
    @CurrentWorkspace() w: WorkspaceContext,
    @Param("itemId") id: string,
    @Param("sceneId") sceneId: string,
    @Body() dto: VideoAttachSceneAssetDto,
    @Req() req: Request,
  ) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.media.attachSceneAsset(w.id, this.actor(u, w), id, sceneId, dto.mediaAssetPublicId, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Phase 7.4: Voice stage + Gate #3 ----
  @Get(":itemId/voice")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async voice(@CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string) {
    const rm = await this.pipeline.projectReadModel(w.id, id);
    return { data: { voice: rm.voice, voiceCatalog: this.media.listVoices() } };
  }

  @Post(":itemId/voice/generate")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async generateVoice(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Body() dto: VideoGenerateVoiceDto, @Req() req: Request) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.media.generateVoice(w.id, this.actor(u, w), id, dto.voiceProfileId, dto.style, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Phase 7.4: Subtitle stage (deterministic) ----
  @Get(":itemId/subtitles")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async subtitles(@CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string) {
    const rm = await this.pipeline.projectReadModel(w.id, id);
    return { data: rm.subtitles };
  }

  @Post(":itemId/subtitles/generate")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async generateSubtitles(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.media.generateSubtitles(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Phase 7.4: Thumbnail concept selection + real image ----
  @Get(":itemId/thumbnail")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async thumbnail(@CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string) {
    const rm = await this.pipeline.projectReadModel(w.id, id);
    return { data: { thumbnailConcepts: rm.thumbnailConcepts, thumbnailImage: rm.thumbnailImage } };
  }

  @Post(":itemId/thumbnail-concepts/select")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async selectThumbnailConcept(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Body() dto: VideoSelectThumbnailConceptDto, @Req() req: Request) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.media.selectThumbnailConcept(w.id, this.actor(u, w), id, dto.conceptIndex, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  @Post(":itemId/thumbnail-image")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async generateThumbnailImage(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.media.generateThumbnailImage(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Phase 7.5: Render stage + Quality Gate #4 ----
  @Get(":itemId/render")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async getRender(@CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string) {
    return { data: await this.render.getRender(w.id, id) };
  }

  @Post(":itemId/render")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.ACCEPTED)
  async submitRender(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.render.submitRender(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Phase 7.5: QA Engine + Quality Gate #5 ----
  @Get(":itemId/qa")
  @RequirePermission(PERMISSIONS.VIDEO_VIEW)
  async getQa(@CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string) {
    return { data: await this.qa.getQa(w.id, id) };
  }

  @Post(":itemId/qa")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.CREATED)
  async runQa(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Req() req: Request) {
    await this.pipeline.ensureAiStagesFinalized(w.id, id, this.actor(u, w), this.ctx(req));
    await this.qa.runQa(w.id, this.actor(u, w), id, this.ctx(req));
    return { data: await this.pipeline.projectReadModel(w.id, id) };
  }

  // ---- Human-review handoff (delegates to Module 1E) ----
  @Post(":itemId/submit-for-review")
  @RequirePermission(PERMISSIONS.VIDEO_EDIT)
  @HttpCode(HttpStatus.OK)
  async submitForReview(
    @CurrentUser() u: AuthenticatedRequest["user"],
    @CurrentWorkspace() w: WorkspaceContext,
    @Param("itemId") id: string,
    @Body() dto: VideoSubmitForReviewDto,
    @Req() req: Request,
  ) {
    return { data: await this.video.submitForReview(w.id, this.actor(u, w), id, dto, this.ctx(req)) };
  }

  // ---- Human Approval — Quality Gate #7 ----
  @Post(":itemId/approve")
  @RequirePermission(PERMISSIONS.VIDEO_APPROVE)
  @HttpCode(HttpStatus.OK)
  async approve(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Body() dto: VideoApproveDto, @Req() req: Request) {
    return { data: await this.video.approve(w.id, this.actor(u, w), id, dto, this.ctx(req)) };
  }

  @Post(":itemId/reject")
  @RequirePermission(PERMISSIONS.VIDEO_APPROVE)
  @HttpCode(HttpStatus.OK)
  async reject(@CurrentUser() u: AuthenticatedRequest["user"], @CurrentWorkspace() w: WorkspaceContext, @Param("itemId") id: string, @Body() dto: VideoRejectDto, @Req() req: Request) {
    return { data: await this.video.reject(w.id, this.actor(u, w), id, dto, this.ctx(req)) };
  }
}
