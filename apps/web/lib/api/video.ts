import { apiClient } from "../api-client";
import type {
  VideoListItem,
  VideoPipeline,
  VideoRenderView,
  VideoScoreFeedback,
  VideoTargetPlatform,
  VideoVoiceProfile,
} from "../types";

export interface CreateVideoInput {
  topic: string;
  knowledgePackVersionId: string;
  targetPlatform: VideoTargetPlatform;
  durationSecondsTarget?: number;
}

const base = (workspaceId: string) => `workspaces/${workspaceId}/video`;

/**
 * Module 7 Phase 7.6 — the one typed Video client. Every page/component
 * goes through here. Read calls (`get`, `render`, `qa`, `voice`, `score`)
 * hit the Phase 7.4/7.5 read-only projections; every other call is a
 * pipeline mutation whose HTTP response `data` is the refreshed read
 * model (`VideoPipeline`). Server-side permission is authoritative on
 * every route — this client never guesses.
 */
export const videoApi = {
  list: (workspaceId: string) => apiClient.get<VideoListItem[]>(base(workspaceId)),
  get: (workspaceId: string, itemId: string) => apiClient.get<VideoPipeline>(`${base(workspaceId)}/${itemId}`),
  create: (workspaceId: string, input: CreateVideoInput) => apiClient.post<VideoPipeline>(base(workspaceId), input),

  // --- text stages ---
  generateBrief: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/brief`),
  generateScript: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/script`),
  approveScript: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/script/approve`),
  generateScenePlan: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/scene-plan`),
  generateSeo: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/seo`),
  generateRecommendations: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/recommendations`),

  // --- assets (Gate #2) ---
  generateSceneImage: (workspaceId: string, itemId: string, sceneId: string) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/assets/scenes/${sceneId}/generate-image`),
  attachSceneAsset: (workspaceId: string, itemId: string, sceneId: string, mediaAssetPublicId: string) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/assets/scenes/${sceneId}/attach`, { mediaAssetPublicId }),

  // --- voice (Gate #3) ---
  voice: (workspaceId: string, itemId: string) =>
    apiClient.get<{ voice: VideoPipeline["voice"]; voiceCatalog: VideoVoiceProfile[] }>(`${base(workspaceId)}/${itemId}/voice`),
  generateVoice: (workspaceId: string, itemId: string, voiceProfileId: string, style?: string) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/voice/generate`, style ? { voiceProfileId, style } : { voiceProfileId }),

  // --- subtitles ---
  generateSubtitles: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/subtitles/generate`),

  // --- thumbnail ---
  generateThumbnailConcepts: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/thumbnail-concepts`),
  selectThumbnailConcept: (workspaceId: string, itemId: string, conceptIndex: number) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/thumbnail-concepts/select`, { conceptIndex }),
  generateThumbnailImage: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/thumbnail-image`),

  // --- render (Gate #4) ---
  render: (workspaceId: string, itemId: string) => apiClient.get<VideoRenderView>(`${base(workspaceId)}/${itemId}/render`),
  submitRender: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/render`),

  // --- QA (Gate #5) ---
  qa: (workspaceId: string, itemId: string) =>
    apiClient.get<{ gate5: { name: string; passed: boolean }; gate4Ready: boolean; qa: VideoPipeline["qa"] }>(`${base(workspaceId)}/${itemId}/qa`),
  runQa: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/qa`),

  // --- SEO score (Video + Thumbnail dimensions on the shared engine) ---
  score: (workspaceId: string, itemId: string) => apiClient.get<VideoScoreFeedback | null>(`${base(workspaceId)}/${itemId}/score`),
  runScore: (workspaceId: string, itemId: string) => apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/score`),

  // --- review / approval (Gate #7) ---
  submitForReview: (workspaceId: string, itemId: string, comment?: string) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/submit-for-review`, comment ? { comment } : {}),
  approve: (workspaceId: string, itemId: string, comment?: string) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/approve`, comment ? { comment } : {}),
  reject: (workspaceId: string, itemId: string, comment: string) =>
    apiClient.post<VideoPipeline>(`${base(workspaceId)}/${itemId}/reject`, { comment }),
};
