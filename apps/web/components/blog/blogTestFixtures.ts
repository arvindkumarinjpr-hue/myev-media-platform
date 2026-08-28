import type { BlogListItem, BlogPipeline, BlogScoreFeedback, WorkspaceDetail } from "../../lib/types";
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

export function listItem(overrides: Partial<BlogListItem> = {}): BlogListItem {
  return {
    publicId: "blog-1",
    title: "Home EV charging guide",
    status: "IN_PROGRESS",
    knowledgePackVersionId: "kp-1",
    brief: "PENDING",
    outline: "PENDING",
    draft: "PENDING",
    seo: "PENDING",
    qa: "PENDING",
    scoring: { status: "PENDING", passed: null, overallScore: null },
    ...overrides,
  };
}

export function pipeline(overrides: Partial<BlogPipeline> = {}): BlogPipeline {
  const base: BlogPipeline = {
    contentItem: { publicId: "blog-1", title: "Home EV charging guide", contentType: "BLOG", status: "IN_PROGRESS" },
    knowledgePackVersionId: "kp-1",
    currentStage: "BRIEF",
    publishReady: false,
    brief: { status: "PENDING", aiJobPublicId: null, artifact: null, approvedAt: null, failureReason: null },
    outline: { status: "PENDING", aiJobPublicId: null, artifact: null, approvedAt: null, failureReason: null },
    draft: { status: "PENDING", aiJobPublicId: null, contentVersionPublicId: null, artifact: null, pendingFinalization: false, failureReason: null },
    seo: { status: "PENDING", aiJobPublicId: null, blogArticlePublicId: null, artifact: null, pendingFinalization: false, failureReason: null },
    internalLinking: { status: "PENDING", suggestions: [], reason: "engine_not_available", completedAt: null },
    qa: { status: "PENDING", checks: [], completedAt: null },
    scoring: { status: "PENDING", contentScorePublicId: null, overallScore: null, passThreshold: null, passed: null, ranAt: null },
    reviewGatesUnmet: ["brief_approved", "outline_approved", "draft_generated", "seo_complete", "internal_linking_completed", "qa_complete", "content_score_run"],
    canSubmitForReview: false,
  };
  return { ...base, ...overrides };
}

export const briefArtifact = {
  searchIntent: "informational" as const,
  targetAudience: "New EV owners",
  primaryKeyword: "home ev charging",
  secondaryKeywords: ["level 2 charger"],
  ctaObjective: "Book an assessment",
  rationale: "How-to intent from buyers.",
};

export const outlineArtifact = {
  h1: "The Complete Guide to Home EV Charging",
  sections: [{ level: 2, heading: "Why charge at home", purpose: "cost case" }],
  faqPlan: ["How much does it cost?"],
};

export const draftArtifact = {
  introduction: "Charging at home is the cheapest option.",
  bodySections: [{ level: 2, heading: "Why charge at home", content: "It costs less per mile." }],
  conclusion: "It pays for itself.",
  cta: "Book an install assessment.",
  faqs: [{ question: "How much?", answer: "A few hundred dollars." }],
};

export const seoArtifact = {
  metaTitle: "Home EV Charging Guide",
  metaDescription: "Everything about charging at home.",
  urlSlug: "home-ev-charging-guide",
  schemaMarkup: { "@type": "Article" },
};

export function scoreFeedback(overrides: Partial<BlogScoreFeedback> = {}): BlogScoreFeedback {
  return {
    overallScore: 82,
    passThreshold: 70,
    passed: true,
    categoryScores: { SEO: 80, VIRAL: 75, QUALITY: 88, ENGAGEMENT: 84, BUSINESS: 82 },
    dimension: { name: "blog", version: 1, label: "Blog", score: 79 },
    recommendations: [{ id: "r1", priority: "medium", category: "SEO", message: "Add more internal context." }],
    factors: [{ id: "f1", category: "SEO", label: "Keyword coverage", value: 80, weight: 1, reason: "Primary keyword used well." }],
    calculatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  };
}

/** A URL-aware fetch mock: match by the path fragment passed as the key. */
export function routeFetch(routes: Record<string, unknown>, fallback?: unknown) {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [fragment, body] of Object.entries(routes)) {
      if (url.includes(fragment)) return mockResponse({ data: body });
    }
    if (fallback !== undefined) return mockResponse({ data: fallback });
    return mockResponse({ code: "NOT_FOUND", message: "not mocked: " + url }, 404);
  });
}
