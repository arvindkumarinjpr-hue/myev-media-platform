import "reflect-metadata";
import {
  AgentRegistryBuilder,
  BLOG_BRIEF_AGENT_V1,
  BLOG_DRAFT_AGENT_V1,
  BLOG_OUTLINE_AGENT_V1,
  RESEARCH_AGENT_V1,
  SEO_METADATA_AGENT_V1,
  TEST_ECHO_AGENT_V1,
} from "../../index";
import { AI_EXECUTE_V1_MANIFEST } from "../../queue/jobs/ai-execute";

/**
 * Module 6 Phase 6.2 — the 4 Blog agents must be registrable and
 * resolvable through the SAME AgentRegistry contract apps/api and
 * apps/worker each use, with stable, distinct ids/versions. The DI
 * modules (apps/api's AgentRegistryModule, apps/worker's) register these
 * exact same objects — a divergence there is caught by
 * blog-agents.e2e-spec.ts in the worker.
 */
const BLOG_AGENTS = [BLOG_BRIEF_AGENT_V1, BLOG_OUTLINE_AGENT_V1, BLOG_DRAFT_AGENT_V1, SEO_METADATA_AGENT_V1];

describe("Blog agents — registration & contract", () => {
  it("each is a structurally valid AgentDefinition (registry accepts it)", () => {
    for (const agent of BLOG_AGENTS) {
      expect(() => new AgentRegistryBuilder().register(agent)).not.toThrow();
      expect(agent.identifier).toMatch(/^[a-z0-9-]+$/);
      expect(Number.isInteger(agent.version) && agent.version >= 1).toBe(true);
      expect(typeof agent.buildPrompt).toBe("function");
      expect(agent.outputSchema).toBeDefined();
    }
  });

  it("all four resolve from a registry that also holds the existing agents", () => {
    const builder = new AgentRegistryBuilder();
    for (const a of [RESEARCH_AGENT_V1, TEST_ECHO_AGENT_V1, ...BLOG_AGENTS]) builder.register(a);
    const registry = builder.freeze();

    expect(registry.resolve("blog-brief-agent", 1)).toBe(BLOG_BRIEF_AGENT_V1);
    expect(registry.resolve("blog-outline-agent", 1)).toBe(BLOG_OUTLINE_AGENT_V1);
    expect(registry.resolve("blog-draft-agent", 1)).toBe(BLOG_DRAFT_AGENT_V1);
    expect(registry.resolve("seo-metadata-agent", 1)).toBe(SEO_METADATA_AGENT_V1);
  });

  it("has distinct, stable identifiers, all at version 1", () => {
    const ids = BLOG_AGENTS.map((a) => a.identifier);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(["blog-brief-agent", "blog-draft-agent", "blog-outline-agent", "seo-metadata-agent"]);
    expect(BLOG_AGENTS.every((a) => a.version === 1)).toBe(true);
  });

  it("rejects registering the same blog agent twice", () => {
    const builder = new AgentRegistryBuilder();
    builder.register(BLOG_BRIEF_AGENT_V1);
    expect(() => builder.register(BLOG_BRIEF_AGENT_V1)).toThrow(/duplicate/i);
  });

  it("every blog agent's timeout is honourable under the ai.execute.v1 manifest ceiling", () => {
    for (const a of BLOG_AGENTS) {
      expect(a.timeoutMs).toBeGreaterThan(0);
      expect(a.timeoutMs).toBeLessThanOrEqual(AI_EXECUTE_V1_MANIFEST.timeout);
    }
    // the frozen figures specifically
    expect(BLOG_DRAFT_AGENT_V1.timeoutMs).toBe(300_000);
    expect(SEO_METADATA_AGENT_V1.timeoutMs).toBe(180_000);
  });

  it("all use the shared AIProviderRegistry preference shape (no direct SDK coupling)", () => {
    for (const a of BLOG_AGENTS) {
      expect(a.providerPreference).toEqual({ provider: "openai", model: "gpt-4o" });
    }
  });
});
