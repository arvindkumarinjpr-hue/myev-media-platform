import "reflect-metadata";
import { AI_EXECUTE_V1_MANIFEST } from "../../queue/jobs/ai-execute";
import { BLOG_BRIEF_AGENT_V1 } from "./blog-brief-agent";
import { BLOG_DRAFT_AGENT_V1 } from "./blog-draft-agent";
import { BLOG_OUTLINE_AGENT_V1 } from "./blog-outline-agent";
import { RESEARCH_AGENT_V1 } from "./research-agent";
import { SEO_METADATA_AGENT_V1 } from "./seo-metadata-agent";

/**
 * Module 6 Phase 6.2 architecture-review correction — the single,
 * generic enforcement point for the durable ai.execute.v1 timeout
 * hierarchy, instead of the same relationship being asserted piecemeal
 * in every agent's own spec file.
 *
 * ai-execute.processor.ts's handler does real work AFTER its own inner
 * AbortController (armed at `definition.timeoutMs`) fires — catching the
 * abort, recording a step, and writing the AiJob's terminal status are
 * all awaited before the handler's promise resolves. The OUTER
 * `Promise.race` timer in bullmq-worker.manager.ts (armed at
 * `AI_EXECUTE_V1_MANIFEST.timeout`) also starts strictly earlier in
 * wall-clock time than that inner timer (KP resolution + a DB step-write
 * happen first). An agent whose `timeoutMs` equals the manifest's
 * `timeout` therefore has no room for that post-abort cleanup: the outer
 * ceiling can fire at or before the inner one, discarding the handler's
 * own graceful FAILED/TIMED_OUT transition for the cruder forced
 * PROCESSOR_TIMEOUT path (see ai-execute.ts's own comment for the full
 * mechanism).
 *
 * Required invariant, enforced here for EVERY registered production
 * agent (never per-agent, so a new agent is automatically covered):
 *
 *   agent.timeoutMs  <  AI_EXECUTE_V1_MANIFEST.timeout  <=  AI_EXECUTE_V1_MANIFEST.maximumRuntime
 */
const PRODUCTION_AGENTS = [RESEARCH_AGENT_V1, BLOG_BRIEF_AGENT_V1, BLOG_OUTLINE_AGENT_V1, BLOG_DRAFT_AGENT_V1, SEO_METADATA_AGENT_V1];

describe("ai.execute.v1 timeout hierarchy invariant", () => {
  it("the manifest's outer timeout does not exceed its maximumRuntime ceiling", () => {
    expect(AI_EXECUTE_V1_MANIFEST.timeout).toBeLessThanOrEqual(AI_EXECUTE_V1_MANIFEST.maximumRuntime);
  });

  it.each(PRODUCTION_AGENTS.map((a) => [a.identifier, a] as const))(
    "%s declares timeoutMs STRICTLY below the manifest's outer timeout (never equal — see file doc comment)",
    (_identifier, agent) => {
      expect(agent.timeoutMs).toBeLessThan(AI_EXECUTE_V1_MANIFEST.timeout);
    },
  );

  it("every registered production agent is covered by this invariant (regression guard against a silently-added, unchecked agent)", () => {
    expect(PRODUCTION_AGENTS.map((a) => a.identifier).sort()).toEqual(
      ["blog-brief-agent", "blog-draft-agent", "blog-outline-agent", "research-agent", "seo-metadata-agent"].sort(),
    );
  });

  // Pinned exact values — a real contractual figure changing is a
  // deliberate decision, never a silent side effect of touching the
  // manifest or another agent.
  it("Research keeps its Module 4 timeout of 25,000ms, unchanged by the Phase 6.2 manifest correction", () => {
    expect(RESEARCH_AGENT_V1.timeoutMs).toBe(25_000);
  });

  it("Blog Draft keeps the FROZEN FRD §21.1 timeout of exactly 300,000ms (5 min)", () => {
    expect(BLOG_DRAFT_AGENT_V1.timeoutMs).toBe(300_000);
  });

  it("SEO Metadata keeps the FROZEN FRD §21.1 timeout of exactly 180,000ms (3 min)", () => {
    expect(SEO_METADATA_AGENT_V1.timeoutMs).toBe(180_000);
  });

  it("the manifest's own outer timeout is exactly 360,000ms — 60s of headroom above the longest agent (Blog Draft, 300,000ms)", () => {
    expect(AI_EXECUTE_V1_MANIFEST.timeout).toBe(360_000);
    expect(AI_EXECUTE_V1_MANIFEST.timeout - BLOG_DRAFT_AGENT_V1.timeoutMs).toBe(60_000);
  });
});
