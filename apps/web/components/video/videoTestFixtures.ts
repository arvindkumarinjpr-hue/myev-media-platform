import type {
  VideoListItem,
  VideoPipeline,
  VideoRenderView,
  VideoScoreFeedback,
  WorkspaceDetail,
} from "../../lib/types";
import { mockResponse } from "../../lib/test-mock-response";

export const testWorkspace: WorkspaceDetail = {
  publicId: "ws-1",
  name: "Demo",
  slug: "demo",
  status: "ACTIVE",
  settings: {},
  featureFlags: {},
  myRole: "Owner",
};

export function listItem(overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    publicId: "video-1",
    title: "Home EV charging",
    status: "IN_PROGRESS",
    knowledgePackVersionId: "kp-1",
    targetPlatform: "YOUTUBE_LONG",
    brief: "PENDING",
    script: "PENDING",
    scenePlan: "PENDING",
    render: "PENDING",
    seo: "PENDING",
    ...overrides,
  };
}

export function pipeline(overrides: Partial<VideoPipeline> = {}): VideoPipeline {
  const base: VideoPipeline = {
    contentItem: { publicId: "video-1", title: "Home EV charging", contentType: "VIDEO", status: "IN_PROGRESS" },
    knowledgePackVersionId: "kp-1",
    videoScript: { publicId: "vs-1", targetPlatform: "YOUTUBE_LONG", exportProfile: "YOUTUBE_LONG", durationSecondsTarget: null },
    currentStage: "BRIEF",
    publishReady: false,
    brief: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null },
    script: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null, approvedAt: null, scriptApproved: false },
    scenePlan: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null },
    assets: { status: "PENDING", scenes: [], missingScenes: [], completedAt: null, failureReason: null },
    voice: {
      status: "PENDING",
      audioAssetPublicId: null,
      wordTimingObjectKey: null,
      scriptVersionHash: null,
      voiceProfileId: null,
      audioDurationMs: null,
      mediaJobPublicId: null,
      failureReason: null,
    },
    subtitles: { status: "PENDING", srtAssetPublicId: null, vttAssetPublicId: null, sourceAudioAssetPublicId: null, cueCount: null, mediaJobPublicId: null, failureReason: null },
    thumbnailImage: {
      status: "PENDING",
      selectedConceptIndex: null,
      imageAssetPublicId: null,
      imageAssetGroupId: null,
      imageWidth: null,
      imageHeight: null,
      mediaJobPublicId: null,
      failureReason: null,
    },
    render: {
      status: "PENDING",
      renderJobPublicId: null,
      renderedVideoPublicId: null,
      renderedVideoAssetGroupId: null,
      exportProfileId: null,
      attempt: 0,
      expectedDurationMs: null,
      outputWidth: null,
      outputHeight: null,
      outputDurationMs: null,
      outputByteSize: null,
      completedAt: null,
      failureReason: null,
    },
    qa: { status: "PENDING", checks: [], passed: null, renderJobPublicId: null, renderedVideoPublicId: null, completedAt: null },
    seo: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null, seoComplete: false },
    thumbnailConcepts: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null, advisory: true },
    recommendations: { status: "PENDING", aiJobPublicId: null, artifact: null, failureReason: null, advisory: true },
    score: { status: "PENDING", contentScorePublicId: null, overallScore: null, videoScore: null, thumbnailScore: null, passThreshold: null, passed: null, ranAt: null },
    reviewGatesUnmet: ["script_approved", "assets_available", "voice_generated", "rendering_successful", "qa_passed", "seo_complete", "content_score_run"],
    canSubmitForReview: false,
    timestamps: { createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z" },
  };
  return { ...base, ...overrides };
}

export const briefArtifact = {
  objective: "Show a new EV owner how to start home charging.",
  audience: "New EV owners",
  targetPlatform: "YOUTUBE_LONG",
  durationSeconds: 120,
  cta: "Book an assessment.",
  rationale: "How-to angle for buyers.",
};

export const scriptArtifact = {
  hook: "Charging your EV at home is easier than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Hook", narration: "Charging your EV at home is easier than you think.", purpose: "hook" },
    { order: 2, id: "seg-2", label: "Setup", narration: "Plug in, pick a schedule, done.", purpose: "steps" },
  ],
  cta: "Book a free install assessment.",
};

export const scenePlanArtifact = {
  scenePlanVersion: 1,
  targetPlatform: "YOUTUBE_LONG",
  scenes: [
    { order: 1, sceneId: "scene-1", scriptSegmentRef: "seg-1", startSeconds: 0, durationSeconds: 3, visualInstruction: "Hands plugging in a charger.", transition: "cut", assetRequirements: [{ kind: "image", description: "Plugging in", sourceHint: "ai_generated" }] },
    { order: 2, sceneId: "scene-2", scriptSegmentRef: "seg-2", startSeconds: 3, durationSeconds: 3, visualInstruction: "Phone app schedule.", transition: "slide", assetRequirements: [{ kind: "image", description: "App UI", sourceHint: "ai_generated" }] },
  ],
};

export const seoArtifact = {
  metaTitle: "Home EV Charging Guide",
  metaDescription: "Everything about charging at home.",
  tags: ["ev charging"],
  chapters: [{ startSeconds: 0, title: "Intro" }],
  hashtags: ["#ev"],
  schemaMarkup: { "@type": "VideoObject", name: "Home EV Charging Guide" },
};

export function scoreFeedback(overrides: Partial<VideoScoreFeedback> = {}): VideoScoreFeedback {
  return {
    overallScore: 81,
    passThreshold: 70,
    passed: true,
    categoryScores: { SEO: 80, VIRAL: 74, QUALITY: 86, ENGAGEMENT: 82, BUSINESS: 80 },
    videoScore: { name: "video", version: 1, label: "Video", score: 78 },
    thumbnailScore: { name: "thumbnail", version: 1, label: "Thumbnail", score: 71 },
    factors: [{ id: "f1", category: "SEO", label: "Keyword coverage", value: 80, weight: 1, reason: "Primary keyword used well." }],
    thumbnailFactors: [],
    recommendations: [{ id: "r1", priority: "medium", category: "SEO", message: "Tighten the meta description." }],
    thumbnailRecommendations: [],
    calculatedAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

export function renderView(overrides: Partial<VideoRenderView> = {}): VideoRenderView {
  return {
    gate4: { name: "rendering_successful", passed: false, failureReason: null },
    render: pipeline().render,
    exportProfile: { id: "YOUTUBE_LONG", width: 1920, height: 1080, fps: 30, aspectRatio: "16:9", container: "mp4" },
    history: [],
    ...overrides,
  };
}

export const voiceCatalog = [
  { voiceProfileId: "en-in-neerja", language: "en-IN", displayName: "Neerja (English, India)", styles: ["neutral", "newscast"] },
  { voiceProfileId: "hi-in-swara", language: "hi-IN", displayName: "Swara (Hindi, India)", styles: ["neutral"] },
];

/** A URL + method aware fetch mock keyed by path fragment. POST routes may be keyed as "POST /brief". */
export function routeFetch(routes: Record<string, unknown>, fallback?: unknown) {
  return jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    for (const [key, body] of Object.entries(routes)) {
      const [maybeMethod, ...rest] = key.split(" ");
      if (rest.length && ["GET", "POST", "PATCH", "DELETE"].includes(maybeMethod)) {
        if (method === maybeMethod && url.includes(rest.join(" "))) return mockResponse({ data: body });
      } else if (url.includes(key)) {
        return mockResponse({ data: body });
      }
    }
    if (fallback !== undefined) return mockResponse({ data: fallback });
    return mockResponse({ code: "NOT_FOUND", message: "not mocked: " + method + " " + url }, 404);
  });
}
