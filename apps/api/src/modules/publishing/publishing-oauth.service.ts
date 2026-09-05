import { Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  buildMetaAuthorizationUrl,
  buildYouTubeAuthorizationUrl,
  exchangeForLongLivedMetaToken,
  exchangeMetaAuthorizationCode,
  exchangeYouTubeAuthorizationCode,
  fetchInstagramAccountIdentity,
  fetchManageablePages,
  fetchYouTubeChannelIdentity,
} from "@myev/shared";
import type { AppConfig } from "../../config/configuration";
import { PublishingAccountsService, type PublishingAccountView } from "./publishing-accounts.service";
import { PublishingOAuthStateService, type PublishingOAuthDiscoveredPage } from "./publishing-oauth-state.service";
import { PUBLISHING_ERRORS } from "./publishing.errors";

const ELIGIBLE_INSTAGRAM_ACCOUNT_TYPES = new Set(["BUSINESS", "MEDIA_CREATOR"]);

export type MetaDiscoveredPageView = PublishingOAuthDiscoveredPage;

/** The SAFE (no pageAccessToken) projection returned to the frontend's account-selection UI. */
export type MetaDiscoveredPageSafeView = Omit<PublishingOAuthDiscoveredPage, "pageAccessToken">;

/**
 * Module 9 Phase 9.7 (Part G/H/I) — the real server-side OAuth connect
 * orchestration for YouTube and Meta. Never puts a client secret or an
 * exchanged token in front of the browser — the browser only ever
 * receives a redirect URL (to the provider) or a redirect back to this
 * app's own frontend; every token exchange happens in this one
 * server-side service.
 */
@Injectable()
export class PublishingOAuthService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly state: PublishingOAuthStateService,
    private readonly accounts: PublishingAccountsService,
  ) {}

  private publishingConfig() {
    return this.config.get("publishing", { infer: true });
  }

  isYouTubeConfigured(): boolean {
    const p = this.publishingConfig();
    return !!(p.youtube.oauthClientId && p.youtube.oauthClientSecret && p.oauth.youtubeRedirectUri);
  }

  isMetaConfigured(): boolean {
    const p = this.publishingConfig();
    return !!(p.meta.appId && p.meta.appSecret && p.oauth.metaRedirectUri);
  }

  async startYouTube(workspaceId: string, workspacePublicId: string, userInternalId: string): Promise<string> {
    if (!this.isYouTubeConfigured()) {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_PROVIDER_NOT_CONFIGURED, message: "YouTube OAuth is not configured on this platform." });
    }
    const p = this.publishingConfig();
    const stateToken = await this.state.create({ workspaceId, workspacePublicId, userInternalId, channelType: "YOUTUBE" });
    return buildYouTubeAuthorizationUrl(
      { clientId: p.youtube.oauthClientId, clientSecret: p.youtube.oauthClientSecret, authorizationEndpoint: p.oauth.youtubeAuthorizationEndpoint },
      { redirectUri: p.oauth.youtubeRedirectUri, state: stateToken },
    );
  }

  async handleYouTubeCallback(code: string, stateToken: string): Promise<{ workspacePublicId: string; account: PublishingAccountView }> {
    const resolvedState = await this.state.consume(stateToken);
    if (!resolvedState || resolvedState.channelType !== "YOUTUBE") {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_STATE_INVALID, message: "This connect link is invalid, expired, or has already been used." });
    }
    const p = this.publishingConfig();
    const clientOptions = { clientId: p.youtube.oauthClientId, clientSecret: p.youtube.oauthClientSecret, tokenEndpoint: p.oauth.youtubeTokenEndpoint };

    let tokens;
    try {
      tokens = await exchangeYouTubeAuthorizationCode(code, p.oauth.youtubeRedirectUri, clientOptions);
    } catch {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_EXCHANGE_FAILED, message: "Failed to complete the YouTube connection. Please try connecting again." });
    }

    let identity;
    try {
      identity = await fetchYouTubeChannelIdentity(tokens.accessToken, { apiBaseUrl: p.oauth.youtubeApiBaseUrl });
    } catch {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_EXCHANGE_FAILED, message: "Connected to Google, but could not read the YouTube channel's identity." });
    }

    const credentialPayload = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, scope: tokens.scope, externalChannelId: identity.channelId };
    const existing = await this.accounts.findByExternalIdentity(resolvedState.workspaceId, "YOUTUBE", identity.channelId);
    const account = existing
      ? await this.accounts.reconnectFromOAuth(resolvedState.workspaceId, resolvedState.userInternalId, existing.publicId, { decryptedCredential: credentialPayload, tokenExpiresAt: tokens.expiresAt })
      : await this.accounts.createFromOAuth(resolvedState.workspaceId, resolvedState.userInternalId, {
          channelType: "YOUTUBE",
          displayName: identity.title,
          externalAccountId: identity.channelId,
          decryptedCredential: credentialPayload,
          tokenExpiresAt: tokens.expiresAt,
        });

    return { workspacePublicId: resolvedState.workspacePublicId, account };
  }

  async startMeta(workspaceId: string, workspacePublicId: string, userInternalId: string): Promise<string> {
    if (!this.isMetaConfigured()) {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_PROVIDER_NOT_CONFIGURED, message: "Meta (Facebook/Instagram) OAuth is not configured on this platform." });
    }
    const p = this.publishingConfig();
    // Channel type is stored as FACEBOOK here even though this one
    // connect flow surfaces both Facebook Pages and their linked
    // Instagram accounts (Part H's own "one Meta auth model" design) —
    // the discovery/selection step afterward is where the operator
    // actually decides which of each get connected as which channel.
    const stateToken = await this.state.create({ workspaceId, workspacePublicId, userInternalId, channelType: "FACEBOOK" });
    return buildMetaAuthorizationUrl(
      { appId: p.meta.appId, appSecret: p.meta.appSecret, dialogBaseUrl: p.oauth.metaDialogBaseUrl },
      { redirectUri: p.oauth.metaRedirectUri, state: stateToken },
    );
  }

  /** Exchanges the code, discovers manageable Pages + their linked Instagram accounts, and stores the (short-lived, single-peek) discovery result — never creates any PublishingChannelAccount row directly; see finalizeMetaSelection(). */
  async handleMetaCallback(code: string, stateToken: string): Promise<{ workspacePublicId: string; discoveryToken: string; pages: MetaDiscoveredPageView[] }> {
    const resolvedState = await this.state.consume(stateToken);
    if (!resolvedState) {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_STATE_INVALID, message: "This connect link is invalid, expired, or has already been used." });
    }
    const p = this.publishingConfig();
    const clientOptions = { appId: p.meta.appId, appSecret: p.meta.appSecret, graphBaseUrl: p.oauth.metaGraphBaseUrl };

    let longLivedToken;
    try {
      const shortLived = await exchangeMetaAuthorizationCode(code, p.oauth.metaRedirectUri, clientOptions);
      longLivedToken = await exchangeForLongLivedMetaToken(shortLived.accessToken, clientOptions);
    } catch {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_EXCHANGE_FAILED, message: "Failed to complete the Meta connection. Please try connecting again." });
    }

    let discoveredPages;
    try {
      discoveredPages = await fetchManageablePages(longLivedToken.accessToken, clientOptions);
    } catch {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_EXCHANGE_FAILED, message: "Connected to Meta, but could not list manageable Pages." });
    }

    const pages: MetaDiscoveredPageView[] = [];
    for (const page of discoveredPages) {
      let instagramUsername: string | undefined;
      let instagramAccountType: string | undefined;
      let instagramEligible = false;
      if (page.instagramBusinessAccountId) {
        try {
          const igIdentity = await fetchInstagramAccountIdentity(page.instagramBusinessAccountId, page.pageAccessToken, clientOptions);
          instagramUsername = igIdentity.username;
          instagramAccountType = igIdentity.accountType;
          instagramEligible = !!igIdentity.accountType && ELIGIBLE_INSTAGRAM_ACCOUNT_TYPES.has(igIdentity.accountType);
        } catch {
          // A per-page lookup failure never fails the whole discovery —
          // this Page's Instagram option is simply marked ineligible.
        }
      }
      pages.push({
        pageId: page.pageId,
        pageName: page.name,
        pageAccessToken: page.pageAccessToken,
        instagramBusinessAccountId: page.instagramBusinessAccountId,
        instagramUsername,
        instagramAccountType,
        instagramEligible,
      });
    }

    const discoveryToken = await this.state.storeDiscovery({
      workspaceId: resolvedState.workspaceId,
      workspacePublicId: resolvedState.workspacePublicId,
      userInternalId: resolvedState.userInternalId,
      pages,
    });

    return { workspacePublicId: resolvedState.workspacePublicId, discoveryToken, pages };
  }

  /**
   * Reads back the discovered Page/Instagram list for the account-
   * selection UI (Part H) — NEVER includes `pageAccessToken` (Part E:
   * "Never return credential plaintext"). Workspace-bound: a discovery
   * token minted for a different workspace is rejected exactly like a
   * not-found, never distinguishing why to the caller.
   */
  async getSafeDiscovery(workspaceId: string, discoveryToken: string): Promise<MetaDiscoveredPageSafeView[]> {
    const discovery = await this.state.peekDiscovery(discoveryToken);
    if (!discovery || discovery.workspaceId !== workspaceId) {
      throw new NotFoundException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_STATE_INVALID, message: "This Meta account selection has expired. Please reconnect." });
    }
    return discovery.pages.map(({ pageAccessToken: _pageAccessToken, ...safe }) => safe);
  }

  /**
   * The account-selection finalize step (Part H/AA) — the operator has
   * seen the discovered Page/Instagram list and picked which to actually
   * connect. `discoveryToken` is read-only (peekDiscovery, not
   * single-use) so re-selecting after a partial failure doesn't require
   * restarting the whole OAuth dance; it still expires on its own short
   * TTL regardless.
   */
  async finalizeMetaSelection(
    workspaceId: string,
    actorUserId: string,
    discoveryToken: string,
    selections: { pageId: string; connectFacebook: boolean; connectInstagram: boolean }[],
  ): Promise<PublishingAccountView[]> {
    const discovery = await this.state.peekDiscovery(discoveryToken);
    if (!discovery || discovery.workspaceId !== workspaceId) {
      throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_STATE_INVALID, message: "This Meta account selection has expired. Please reconnect." });
    }

    const created: PublishingAccountView[] = [];
    for (const selection of selections) {
      const page = discovery.pages.find((p) => p.pageId === selection.pageId);
      if (!page) continue;

      if (selection.connectFacebook) {
        const credentialPayload = { accessToken: page.pageAccessToken, pageId: page.pageId };
        const existing = await this.accounts.findByExternalIdentity(workspaceId, "FACEBOOK", page.pageId);
        created.push(
          existing
            ? await this.accounts.reconnectFromOAuth(workspaceId, actorUserId, existing.publicId, { decryptedCredential: credentialPayload, tokenExpiresAt: null })
            : await this.accounts.createFromOAuth(workspaceId, actorUserId, { channelType: "FACEBOOK", displayName: page.pageName, externalAccountId: page.pageId, decryptedCredential: credentialPayload, tokenExpiresAt: null }),
        );
      }

      if (selection.connectInstagram) {
        if (!page.instagramBusinessAccountId || !page.instagramEligible) {
          throw new UnprocessableEntityException({ code: PUBLISHING_ERRORS.PUBLISHING_OAUTH_ACCOUNT_INELIGIBLE, message: "The selected Page has no eligible Instagram Business/Creator account to connect." });
        }
        const credentialPayload = { accessToken: page.pageAccessToken, igUserId: page.instagramBusinessAccountId, pageId: page.pageId };
        const existing = await this.accounts.findByExternalIdentity(workspaceId, "INSTAGRAM", page.instagramBusinessAccountId);
        created.push(
          existing
            ? await this.accounts.reconnectFromOAuth(workspaceId, actorUserId, existing.publicId, { decryptedCredential: credentialPayload, tokenExpiresAt: null })
            : await this.accounts.createFromOAuth(workspaceId, actorUserId, {
                channelType: "INSTAGRAM",
                displayName: page.instagramUsername ? `@${page.instagramUsername}` : page.pageName,
                externalAccountId: page.instagramBusinessAccountId,
                decryptedCredential: credentialPayload,
                tokenExpiresAt: null,
              }),
        );
      }
    }
    return created;
  }
}
