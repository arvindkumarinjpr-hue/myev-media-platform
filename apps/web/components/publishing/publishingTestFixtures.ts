import type { PublicationListItemView, PublicationTargetView, PublishingAccountView, WorkspaceDetail } from "../../lib/types";

export const testWorkspace: WorkspaceDetail = {
  publicId: "ws-1",
  name: "Demo",
  slug: "demo",
  status: "ACTIVE",
  settings: {},
  featureFlags: {},
  myRole: "Owner",
};

export function account(overrides: Partial<PublishingAccountView> = {}): PublishingAccountView {
  return {
    publicId: "acct-1",
    channelType: "WORDPRESS",
    displayName: "MYEV Blog",
    externalAccountId: "https://example.com",
    connectionStatus: "CONNECTED",
    tokenExpiresAt: null,
    lastVerifiedAt: "2026-08-30T00:00:00.000Z",
    disconnectedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

export function target(overrides: Partial<PublicationTargetView> = {}): PublicationTargetView {
  return {
    publicId: "target-1",
    channelAccountPublicId: "acct-1",
    channelType: "WORDPRESS",
    channelDisplayName: "MYEV Blog",
    status: "PENDING",
    scheduledFor: null,
    publishedAt: null,
    cancelledAt: null,
    externalContentId: null,
    externalUrl: null,
    lastErrorCode: null,
    lastErrorMessageSafe: null,
    retryCount: 0,
    reconciliationRequired: false,
    ...overrides,
  };
}

export function publication(overrides: Partial<PublicationListItemView> = {}): PublicationListItemView {
  const targets = overrides.targets ?? [target()];
  return {
    publicId: "pub-1",
    contentItemPublicId: "video-1",
    contentTitle: "Home EV charging",
    contentType: "VIDEO",
    requestedAt: "2026-09-01T00:00:00.000Z",
    scheduledFor: null,
    summary: {
      totalTargets: targets.length,
      publishedCount: targets.filter((t) => t.status === "PUBLISHED").length,
      failedCount: targets.filter((t) => t.status === "FAILED").length,
      cancelledCount: targets.filter((t) => t.status === "CANCELLED").length,
      liveCount: targets.filter((t) => ["PENDING", "SCHEDULED", "QUEUED", "PUBLISHING"].includes(t.status)).length,
      isFullyPublished: targets.every((t) => t.status === "PUBLISHED"),
      hasPartialFailure: targets.some((t) => t.status === "FAILED"),
      isFullyTerminal: targets.every((t) => ["PUBLISHED", "FAILED", "CANCELLED"].includes(t.status)),
    },
    targets,
    ...overrides,
  };
}
