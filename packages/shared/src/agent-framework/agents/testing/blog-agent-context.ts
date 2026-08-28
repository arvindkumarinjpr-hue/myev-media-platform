import type { AgentContext } from "../../agent-context";

/**
 * Module 6 Phase 6.2 — a plain AgentContext for the Blog agent unit
 * tests. Same shape apps/api's AgentContextBuilder produces from a
 * resolved Knowledge Pack snapshot; not exported from the package
 * barrel (test-support only, like test-agent.ts).
 */
export function blogAgentContext(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    workspaceId: "ws_1",
    knowledgePackVersionId: "kp_v1",
    industryProfile: { industry: "Electric Vehicles", region: "US" },
    publishingStrategy: { cadence: "weekly", channels: ["blog"] },
    trustedSources: [],
    promptTemplates: [],
    seoRules: [{ rule: "primary keyword in first paragraph" }],
    brandGuidelines: [{ toneOfVoice: "practical, expert, encouraging" }],
    keywords: [{ name: "core", keywords: ["home ev charging", "level 2 charger"] }],
    competitors: [],
    ...overrides,
  };
}
