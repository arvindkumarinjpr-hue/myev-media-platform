import type { KnowledgePackDetail } from "./types";

export function makeKnowledgePack(overrides: Partial<KnowledgePackDetail> = {}): KnowledgePackDetail {
  return {
    publicId: "kp-1",
    name: "EV Content Pack",
    status: "DRAFT",
    versionNumber: 1,
    lockVersion: 1,
    industryProfile: { industry: "Electric Vehicles" },
    publishingStrategy: { cadence: "weekly" },
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
    sources: [],
    promptTemplates: [],
    seoRules: [],
    brandGuidelines: [],
    keywordSets: [],
    competitors: [],
    ...overrides,
  };
}
