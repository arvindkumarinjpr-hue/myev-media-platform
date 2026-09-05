import { Body, Controller, Get, Post, Query, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Response } from "express";
import { CurrentWorkspace } from "../../common/decorators/current-workspace.decorator";
import { RequirePermission } from "../../common/decorators/require-permission.decorator";
import { PermissionGuard } from "../../common/guards/permission.guard";
import { SessionGuard } from "../../common/guards/session.guard";
import { WorkspaceContextGuard, type WorkspaceContext } from "../../common/guards/workspace-context.guard";
import type { AppConfig } from "../../config/configuration";
import { PERMISSIONS } from "../rbac/permissions.constants";
import { MetaFinalizeSelectionDto } from "./dto/meta-finalize-selection.dto";
import { PublishingOAuthService } from "./publishing-oauth.service";

/**
 * Module 9 Phase 9.7 (Part G) — the authenticated half of the OAuth
 * connect flow: "start" (mints state, returns the provider's own
 * authorization URL for the frontend to navigate to) and Meta's
 * "finalize" (the account-selection step). Same guard/permission shape
 * as PublishingAccountsController — connecting a channel is exactly the
 * PUBLISH_CHANNEL_MANAGE action whether it goes through WordPress's
 * manual form or an OAuth provider.
 */
@Controller("api/v1/workspaces/:workspaceId/publishing/oauth")
@UseGuards(SessionGuard, WorkspaceContextGuard, PermissionGuard)
export class PublishingOAuthStartController {
  constructor(private readonly oauth: PublishingOAuthService) {}

  @Get("youtube/start")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async startYouTube(@CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: { authorizationUrl: await this.oauth.startYouTube(workspace.id, workspace.publicId, workspace.userInternalId) } };
  }

  @Get("meta/start")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async startMeta(@CurrentWorkspace() workspace: WorkspaceContext) {
    return { data: { authorizationUrl: await this.oauth.startMeta(workspace.id, workspace.publicId, workspace.userInternalId) } };
  }

  @Get("meta/discovery")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async getMetaDiscovery(@CurrentWorkspace() workspace: WorkspaceContext, @Query("discoveryToken") discoveryToken: string) {
    return { data: await this.oauth.getSafeDiscovery(workspace.id, discoveryToken ?? "") };
  }

  @Post("meta/finalize")
  @RequirePermission(PERMISSIONS.PUBLISH_CHANNEL_MANAGE)
  async finalizeMeta(@CurrentWorkspace() workspace: WorkspaceContext, @Body() dto: MetaFinalizeSelectionDto) {
    return { data: await this.oauth.finalizeMetaSelection(workspace.id, workspace.userInternalId, dto.discoveryToken, dto.selections) };
  }
}

/**
 * Module 9 Phase 9.7 (Part I) — the UNAUTHENTICATED half. Google/Meta
 * redirect the bare browser here with only `?code&state` — there is no
 * session cookie, no workspace header, nothing this process can trust
 * except what it ITSELF wrote into the opaque `state` at start-time
 * (PublishingOAuthStateService, consumed exactly once). Deliberately NOT
 * workspace-scoped in the URL path (Part I: "Do not trust workspaceId/
 * userId from callback query parameters") — every workspace binding
 * comes from the validated state alone.
 *
 * No open-redirect surface: the post-callback redirect target is always
 * CONSTRUCTED here from the workspace's own publicId (recovered from the
 * validated state), never from a caller-supplied URL — there is nothing
 * to allowlist because no external redirect target is ever accepted as
 * input.
 */
@Controller("api/v1/publishing/oauth")
export class PublishingOAuthCallbackController {
  constructor(
    private readonly oauth: PublishingOAuthService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private appUrl(): string {
    return this.config.get("appUrl", { infer: true });
  }

  @Get("youtube/callback")
  async youtubeCallback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Res() res: Response): Promise<void> {
    try {
      const { workspacePublicId } = await this.oauth.handleYouTubeCallback(code ?? "", state ?? "");
      res.redirect(`${this.appUrl()}/workspaces/${workspacePublicId}/publishing/accounts?connected=youtube`);
    } catch {
      res.redirect(`${this.appUrl()}/publishing/oauth-error?provider=youtube`);
    }
  }

  @Get("meta/callback")
  async metaCallback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Res() res: Response): Promise<void> {
    try {
      const { workspacePublicId, discoveryToken } = await this.oauth.handleMetaCallback(code ?? "", state ?? "");
      res.redirect(`${this.appUrl()}/workspaces/${workspacePublicId}/publishing/accounts/connect/meta?discoveryToken=${encodeURIComponent(discoveryToken)}`);
    } catch {
      res.redirect(`${this.appUrl()}/publishing/oauth-error?provider=meta`);
    }
  }
}
