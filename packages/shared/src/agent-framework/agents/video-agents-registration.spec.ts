import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import {
  AgentRegistryBuilder,
  BLOG_BRIEF_AGENT_V1,
  RESEARCH_AGENT_V1,
  TEST_ECHO_AGENT_V1,
  THUMBNAIL_CONCEPT_AGENT_V1,
  VIDEO_BRIEF_AGENT_V1,
  VIDEO_RECOMMENDATIONS_AGENT_V1,
  VIDEO_SCENE_PLANNER_AGENT_V1,
  VIDEO_SCRIPT_AGENT_V1,
  VIDEO_SEO_METADATA_AGENT_V1,
} from "../../index";

/**
 * Module 7 Phase 7.2 — the 6 Video agents must be registrable and
 * resolvable through the SAME AgentRegistry contract apps/api and
 * apps/worker each use, with stable, distinct ids/versions — mirrors
 * blog-agents-registration.spec.ts exactly. The two DI modules
 * (apps/api's AgentRegistryModule, apps/worker's) register these exact
 * same objects; api-worker-agent-registry-sync.spec.ts (apps/api) proves
 * the two module source files stay synchronized.
 */
const VIDEO_AGENTS = [
  VIDEO_BRIEF_AGENT_V1,
  VIDEO_SCRIPT_AGENT_V1,
  VIDEO_SCENE_PLANNER_AGENT_V1,
  VIDEO_SEO_METADATA_AGENT_V1,
  THUMBNAIL_CONCEPT_AGENT_V1,
  VIDEO_RECOMMENDATIONS_AGENT_V1,
];

describe("Video agents — registration & contract", () => {
  it("each is a structurally valid AgentDefinition (registry accepts it)", () => {
    for (const agent of VIDEO_AGENTS) {
      expect(() => new AgentRegistryBuilder().register(agent)).not.toThrow();
      expect(agent.identifier).toMatch(/^[a-z0-9-]+$/);
      expect(Number.isInteger(agent.version) && agent.version >= 1).toBe(true);
      expect(typeof agent.buildPrompt).toBe("function");
      expect(agent.outputSchema).toBeDefined();
    }
  });

  it("all six resolve from a registry that also holds the existing agents", () => {
    const builder = new AgentRegistryBuilder();
    for (const a of [RESEARCH_AGENT_V1, TEST_ECHO_AGENT_V1, BLOG_BRIEF_AGENT_V1, ...VIDEO_AGENTS]) builder.register(a);
    const registry = builder.freeze();

    expect(registry.resolve("video-brief-agent", 1)).toBe(VIDEO_BRIEF_AGENT_V1);
    expect(registry.resolve("video-script-agent", 1)).toBe(VIDEO_SCRIPT_AGENT_V1);
    expect(registry.resolve("video-scene-planner-agent", 1)).toBe(VIDEO_SCENE_PLANNER_AGENT_V1);
    expect(registry.resolve("video-seo-metadata-agent", 1)).toBe(VIDEO_SEO_METADATA_AGENT_V1);
    expect(registry.resolve("thumbnail-concept-agent", 1)).toBe(THUMBNAIL_CONCEPT_AGENT_V1);
    expect(registry.resolve("video-recommendations-agent", 1)).toBe(VIDEO_RECOMMENDATIONS_AGENT_V1);
  });

  it("has distinct, stable identifiers, all at version 1", () => {
    const ids = VIDEO_AGENTS.map((a) => a.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(
      ["video-brief-agent", "video-script-agent", "video-scene-planner-agent", "video-seo-metadata-agent", "thumbnail-concept-agent", "video-recommendations-agent"].sort(),
    );
    expect(VIDEO_AGENTS.every((a) => a.version === 1)).toBe(true);
  });

  it("rejects registering the same video agent twice", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(VIDEO_BRIEF_AGENT_V1);
    expect(() => builder.register(VIDEO_BRIEF_AGENT_V1)).toThrow(/duplicate/i);
  });

  it("every video agent declares a positive timeout", () => {
    for (const a of VIDEO_AGENTS) expect(a.timeoutMs).toBeGreaterThan(0);
  });
  // The timeoutMs-vs-ai.execute.v1-manifest relationship is enforced
  // generically for every registered production agent (including these
  // 6) in agent-timeout-invariant.spec.ts — not duplicated here.

  it("all use the shared AIProviderRegistry preference shape (no direct SDK coupling)", () => {
    for (const a of VIDEO_AGENTS) {
      expect(a.providerPreference).toEqual({ provider: "openai", model: "gpt-4o" });
    }
  });

  it("the Video SEO agent produces a distinct contract from the Blog SEO agent (no Blog-specific coupling)", async () => {
    // Structural proof, not just naming: a payload shaped like the Blog
    // SEO contract (urlSlug, no tags/chapters/hashtags) fails Video SEO
    // validation; the Video shape (tags/chapters/hashtags, no urlSlug)
    // passes — the two contracts are genuinely distinct, not one
    // conditionally-shaped schema.
    const blogShaped = plainToInstance(VIDEO_SEO_METADATA_AGENT_V1.outputSchema!, {
      metaTitle: "t",
      metaDescription: "d",
      urlSlug: "a-slug",
      schemaMarkup: { "@type": "VideoObject", name: "n" },
    });
    const blogShapedErrors = await validate(blogShaped, { whitelist: false });
    expect(blogShapedErrors.length).toBeGreaterThan(0); // missing tags/chapters/hashtags

    const videoShaped = plainToInstance(VIDEO_SEO_METADATA_AGENT_V1.outputSchema!, {
      metaTitle: "t",
      metaDescription: "d",
      tags: ["ev", "charging"],
      chapters: [],
      hashtags: ["#ev"],
      schemaMarkup: { "@type": "VideoObject", name: "n" },
    });
    const videoShapedErrors = await validate(videoShaped, { whitelist: false });
    expect(videoShapedErrors).toEqual([]);
  });
});
