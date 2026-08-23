import { buildAgentContext } from "./agent-context-builder";
import type { KnowledgePackWithChildren } from "../knowledge-packs/knowledge-packs.service";

function pack(overrides: Partial<KnowledgePackWithChildren> = {}): KnowledgePackWithChildren {
  return {
    id: "internal-id",
    publicId: "public-id",
    workspaceId: "ws-1",
    name: "Test Pack",
    projectId: null,
    industryProfile: { industry: "EV" },
    publishingStrategy: { cadence: "weekly" },
    versionNumber: 1,
    currentVersionOfId: null,
    lineageRootId: "internal-id",
    lockVersion: 1,
    status: "ACTIVE",
    createdById: "user-1",
    updatedById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt: null,
    deletedAt: null,
    knowledgeSources: [{ id: "s1", knowledgePackId: "internal-id", sourceType: "GOVERNMENT", url: "https://example.gov", createdAt: new Date(), updatedAt: new Date() }],
    promptTemplates: [{ id: "t1", knowledgePackId: "internal-id", contentType: "BLOG", promptBody: "Write a blog", versionNumber: 1, createdAt: new Date(), updatedAt: new Date() }],
    seoRules: [
      {
        id: "r1",
        knowledgePackId: "internal-id",
        primaryKeywords: ["ev charging"],
        secondaryKeywords: [],
        internalLinkingPolicy: {},
        schemaPreferences: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ],
    brandGuidelines: [{ id: "b1", knowledgePackId: "internal-id", toneOfVoice: "confident", terminology: {}, ctaRules: "Always end with a CTA", logoAssetId: null, createdAt: new Date(), updatedAt: new Date() }],
    keywordSets: [{ id: "k1", knowledgePackId: "internal-id", name: "primary", keywords: ["ev", "charging"], createdAt: new Date(), updatedAt: new Date() }],
    competitors: [{ id: "c1", knowledgePackId: "internal-id", domain: "competitor.example", notes: null, createdAt: new Date(), updatedAt: new Date() }],
    ...overrides,
  } as unknown as KnowledgePackWithChildren;
}

describe("buildAgentContext", () => {
  it("maps every Knowledge Pack field group into the provider-neutral AgentContext shape", () => {
    const context = buildAgentContext(pack());

    expect(context.workspaceId).toBe("ws-1");
    expect(context.knowledgePackVersionId).toBe("public-id");
    expect(context.industryProfile).toEqual({ industry: "EV" });
    expect(context.publishingStrategy).toEqual({ cadence: "weekly" });
    expect(context.trustedSources).toEqual([{ sourceType: "GOVERNMENT", url: "https://example.gov" }]);
    expect(context.promptTemplates).toEqual([{ contentType: "BLOG", promptBody: "Write a blog", versionNumber: 1 }]);
    expect(context.seoRules).toEqual([{ primaryKeywords: ["ev charging"], secondaryKeywords: [], internalLinkingPolicy: {}, schemaPreferences: {} }]);
    expect(context.brandGuidelines).toEqual([{ toneOfVoice: "confident", terminology: {}, ctaRules: "Always end with a CTA" }]);
    expect(context.keywords).toEqual([{ name: "primary", keywords: ["ev", "charging"] }]);
    expect(context.competitors).toEqual([{ domain: "competitor.example", notes: null }]);
  });

  it("never leaks internal Prisma fields (id, lockVersion, lineageRootId) into the context", () => {
    const context = buildAgentContext(pack());
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain("lockVersion");
    expect(serialized).not.toContain("lineageRootId");
    expect(serialized).not.toContain("internal-id");
  });

  it("produces an empty array for each child collection when the pack has none", () => {
    const context = buildAgentContext(
      pack({ knowledgeSources: [], promptTemplates: [], seoRules: [], brandGuidelines: [], keywordSets: [], competitors: [] }),
    );
    expect(context.trustedSources).toEqual([]);
    expect(context.promptTemplates).toEqual([]);
    expect(context.seoRules).toEqual([]);
    expect(context.brandGuidelines).toEqual([]);
    expect(context.keywords).toEqual([]);
    expect(context.competitors).toEqual([]);
  });
});
