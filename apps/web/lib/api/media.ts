import { apiClient } from "../api-client";
import type { MediaDownloadUrl } from "../types";

/**
 * Module 7 Phase 7.6 — the secure media-access client. The only way the
 * Video workspace ever reaches a private MediaAsset (scene image, voice
 * audio, thumbnail, rendered video): a short-lived presigned URL from the
 * existing `GET /workspaces/:id/assets/:assetId/download-url`
 * (MEDIA_VIEW-gated on the backend, workspace-scoped, ACTIVE-only,
 * rate-limited, audited). Object-storage keys never reach the client;
 * buckets are never made public.
 */
export const mediaApi = {
  downloadUrl: (workspaceId: string, assetPublicId: string) =>
    apiClient.get<MediaDownloadUrl>(`workspaces/${workspaceId}/assets/${assetPublicId}/download-url`),
};
