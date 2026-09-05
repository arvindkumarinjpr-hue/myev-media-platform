import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { CreatePublicationDto } from "./dto/create-publication.dto";
import { ConfirmNotPublishedDto, MarkExternallyPublishedDto } from "./dto/reconciliation.dto";
import { PublishingDispatchService } from "./publishing-dispatch.service";
import { PublishingPersistenceService } from "./publishing-persistence.service";
import { PublishingQueryService } from "./publishing-query.service";
import { PublishingReadinessService } from "./publishing-readiness.service";
import { PublishingReconciliationService } from "./publishing-reconciliation.service";

/**
 * Module 9 Phase 9.7 (Part N) — the operator-facing Publication API.
 * Thin throughout: every route delegates to an existing (or Phase 9.7's
 * own narrowly-scoped new) service; no execution/domain logic is
 * duplicated here (Part N: "Do NOT duplicate execution logic in
 * controllers"). `createPublication()`/`dispatchTarget()`/`cancelTarget()`
 * are Phase 9.1/9.3's own already-battle-tested services, reused
 * verbatim.
 */
@Controller("api/v1/workspaces/:workspaceId/publishing/publications")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class PublishingPublicationsController {
  constructor(
    private readonly persistence: PublishingPersistenceService,
    private readonly dispatch: PublishingDispatchService,
    private readonly readiness: PublishingReadinessService,
    private readonly query: PublishingQueryService,
    private readonly reconciliation: PublishingReconciliationService,
  ) {}

  private ctx(req: Request): { ipAddress?: string } {
    return { ipAddress: req.ip };
  }

  /** Readiness preview (Part O) — a per-channel "Ready/Blocked + safe reasons" check before the operator ever submits. */
  @Get("readiness")
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async previewReadiness(@CurrentWorkspace() workspace: WorkspaceContext, @Query("contentItemId") contentItemId: string, @Query("channelAccountId") channelAccountId: string) {
    return { data: await this.readiness.evaluateReadiness(workspace.id, contentItemId, channelAccountId) };
  }

  @Get()
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async list(@CurrentWorkspace() workspace: WorkspaceContext, @Query("status") status?: string, @Query("channelType") channelType?: string, @Query("contentType") contentType?: string) {
    return { data: await this.query.listPublications(workspace.id, { status, channelType, contentType }) };
  }

  @Get(":publicationId")
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async detail(@CurrentWorkspace() workspace: WorkspaceContext, @Param("publicationId") publicationId: string) {
    return { data: await this.query.getPublicationDetail(workspace.id, publicationId) };
  }

  @Get("targets/:targetId/attempts")
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async targetAttempts(@CurrentWorkspace() workspace: WorkspaceContext, @Param("targetId") targetId: string) {
    return { data: await this.query.getTargetAttempts(workspace.id, targetId) };
  }

  /**
   * Create (Part N/P/Q) — `PublishingPersistenceService.createPublication()`
   * (Phase 9.1) does the actual eligibility/persistence work. When NOT
   * scheduled ("publish now"), every created target is immediately
   * dispatched via the SAME `PublishingDispatchService.dispatchTarget()`
   * (Phase 9.3) a retry uses — one execution path, never a second
   * "immediate publish" implementation.
   */
  @Post()
  @RequirePermission(PERMISSIONS.PUBLISH_CREATE)
  async create(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: CreatePublicationDto) {
    const { publication, targets } = await this.persistence.createPublication(
      workspace.id,
      workspace.userInternalId,
      { contentItemPublicId: dto.contentItemPublicId, channelAccountPublicIds: dto.channelAccountPublicIds, scheduledFor: dto.scheduledFor ? new Date(dto.scheduledFor) : undefined },
      this.ctx(req),
    );
    if (!dto.scheduledFor) {
      for (const target of targets) {
        await this.dispatch.dispatchTarget(workspace.id, workspace.userInternalId, target.publicId, this.ctx(req));
      }
    }
    return { data: await this.query.getPublicationDetail(workspace.id, publication.publicId) };
  }

  @Post("targets/:targetId/retry")
  @RequirePermission(PERMISSIONS.PUBLISH_EXECUTE)
  async retry(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("targetId") targetId: string) {
    const { target } = await this.dispatch.dispatchTarget(workspace.id, workspace.userInternalId, targetId, this.ctx(req));
    return { data: target };
  }

  @Post("targets/:targetId/cancel")
  @RequirePermission(PERMISSIONS.PUBLISH_CANCEL)
  async cancel(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("targetId") targetId: string) {
    return { data: await this.dispatch.cancelTarget(workspace.id, workspace.userInternalId, targetId, this.ctx(req)) };
  }

  /**
   * Manual reconciliation (Part V/W/X) — gated by PUBLISH_CHANNEL_MANAGE,
   * NOT PUBLISH_EXECUTE: this is the most privileged, most novel action
   * in this phase (asserting unverifiable external truth, bypassing the
   * normal execution safety net), and PUBLISH_CHANNEL_MANAGE is already
   * this codebase's own designated "high-trust, Owner/Administrator-only"
   * Publishing permission — reused rather than inventing a new one.
   */
  @Post("targets/:targetId/reconcile/mark-published")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async markExternallyPublished(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("targetId") targetId: string, @Body() dto: MarkExternallyPublishedDto) {
    return { data: await this.reconciliation.markExternallyPublished(workspace.id, workspace.userInternalId, targetId, dto, this.ctx(req)) };
  }

  @Post("targets/:targetId/reconcile/confirm-not-published")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async confirmNotPublished(@Req() req: Request, @CurrentWorkspace() workspace: WorkspaceContext, @Param("targetId") targetId: string, @Body() dto: ConfirmNotPublishedDto) {
    return { data: await this.reconciliation.confirmNotPublished(workspace.id, workspace.userInternalId, targetId, dto, this.ctx(req)) };
  }
}
