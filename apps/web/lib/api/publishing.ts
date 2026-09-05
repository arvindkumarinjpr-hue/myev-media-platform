import { apiClient } from "../api-client";
import type { MetaDiscoveredPage, PublicationListItemView, PublishingAccountView, PublishingReadinessResult, SafeAttemptView } from "../types";

const accountsBase = (workspaceId: string) => `workspaces/${workspaceId}/publishing/accounts`;
const oauthBase = (workspaceId: string) => `workspaces/${workspaceId}/publishing/oauth`;
const publicationsBase = (workspaceId: string) => `workspaces/${workspaceId}/publishing/publications`;

export interface ConnectWordPressInput {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  displayName: string;
}

export interface RotateWordPressInput {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}

export interface CreatePublicationInput {
  contentItemPublicId: string;
  channelAccountPublicIds: string[];
  /** ISO 8601 — omit for "publish now". */
  scheduledFor?: string;
}

export interface MetaFinalizeSelectionInput {
  discoveryToken: string;
  selections: { pageId: string; connectFacebook: boolean; connectInstagram: boolean }[];
}

/**
 * Module 9 Phase 9.7 — the one typed Publishing client. Mirrors
 * lib/api/video.ts's own established shape: every page/component goes
 * through here, server-side permission remains authoritative on every
 * route regardless of what this client (or the UI it feeds) assumes.
 */
export const publishingApi = {
  accounts: {
    list: (workspaceId: string) => apiClient.get<PublishingAccountView[]>(accountsBase(workspaceId)),
    detail: (workspaceId: string, accountId: string) => apiClient.get<PublishingAccountView>(`${accountsBase(workspaceId)}/${accountId}`),
    connectWordPress: (workspaceId: string, input: ConnectWordPressInput) => apiClient.post<PublishingAccountView>(`${accountsBase(workspaceId)}/wordpress`, input),
    rotateWordPress: (workspaceId: string, accountId: string, input: RotateWordPressInput) => apiClient.put<PublishingAccountView>(`${accountsBase(workspaceId)}/${accountId}/wordpress/credential`, input),
    testConnection: (workspaceId: string, accountId: string) => apiClient.post<PublishingAccountView>(`${accountsBase(workspaceId)}/${accountId}/test-connection`),
    disconnect: (workspaceId: string, accountId: string) => apiClient.delete<PublishingAccountView>(`${accountsBase(workspaceId)}/${accountId}`),
  },
  oauth: {
    startYouTube: (workspaceId: string) => apiClient.get<{ authorizationUrl: string }>(`${oauthBase(workspaceId)}/youtube/start`),
    startMeta: (workspaceId: string) => apiClient.get<{ authorizationUrl: string }>(`${oauthBase(workspaceId)}/meta/start`),
    getMetaDiscovery: (workspaceId: string, discoveryToken: string) => apiClient.get<MetaDiscoveredPage[]>(`${oauthBase(workspaceId)}/meta/discovery?discoveryToken=${encodeURIComponent(discoveryToken)}`),
    finalizeMeta: (workspaceId: string, input: MetaFinalizeSelectionInput) => apiClient.post<PublishingAccountView[]>(`${oauthBase(workspaceId)}/meta/finalize`, input),
  },
  publications: {
    list: (workspaceId: string, filters: { status?: string; channelType?: string; contentType?: string } = {}) => {
      const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => !!v) as [string, string][]).toString();
      return apiClient.get<PublicationListItemView[]>(`${publicationsBase(workspaceId)}${query ? `?${query}` : ""}`);
    },
    detail: (workspaceId: string, publicationId: string) => apiClient.get<PublicationListItemView>(`${publicationsBase(workspaceId)}/${publicationId}`),
    readiness: (workspaceId: string, contentItemId: string, channelAccountId: string) =>
      apiClient.get<PublishingReadinessResult>(`${publicationsBase(workspaceId)}/readiness?contentItemId=${encodeURIComponent(contentItemId)}&channelAccountId=${encodeURIComponent(channelAccountId)}`),
    create: (workspaceId: string, input: CreatePublicationInput) => apiClient.post<PublicationListItemView>(publicationsBase(workspaceId), input),
    retry: (workspaceId: string, targetId: string) => apiClient.post(`${publicationsBase(workspaceId)}/targets/${targetId}/retry`),
    cancel: (workspaceId: string, targetId: string) => apiClient.post(`${publicationsBase(workspaceId)}/targets/${targetId}/cancel`),
    attempts: (workspaceId: string, targetId: string) => apiClient.get<SafeAttemptView[]>(`${publicationsBase(workspaceId)}/targets/${targetId}/attempts`),
    markExternallyPublished: (workspaceId: string, targetId: string, input: { externalContentId: string; externalUrl?: string; note: string }) =>
      apiClient.post(`${publicationsBase(workspaceId)}/targets/${targetId}/reconcile/mark-published`, input),
    confirmNotPublished: (workspaceId: string, targetId: string, input: { note: string }) => apiClient.post(`${publicationsBase(workspaceId)}/targets/${targetId}/reconcile/confirm-not-published`, input),
  },
};
