import { Global, Module } from "@nestjs/common";
import {
  AgentRegistryBuilder,
  BLOG_BRIEF_AGENT_V1,
  BLOG_DRAFT_AGENT_V1,
  BLOG_OUTLINE_AGENT_V1,
  RESEARCH_AGENT_V1,
  SEO_METADATA_AGENT_V1,
  TEST_ECHO_AGENT_V1,
  TEST_FLAKY_AGENT_V1,
  TEST_PERMANENT_FAIL_AGENT_V1,
  TEST_TIMEOUT_AGENT_V1,
  THUMBNAIL_CONCEPT_AGENT_V1,
  VIDEO_BRIEF_AGENT_V1,
  VIDEO_RECOMMENDATIONS_AGENT_V1,
  VIDEO_SCENE_PLANNER_AGENT_V1,
  VIDEO_SCRIPT_AGENT_V1,
  VIDEO_SEO_METADATA_AGENT_V1,
  type AgentRegistry,
} from "@myev/shared";

export const AGENT_REGISTRY = Symbol("AGENT_REGISTRY");

/**
 * Module 3 Phase 3.2's own AgentRegistry, mirroring
 * QueueRegistryModule/AiProviderRegistryModule's exact
 * @Global/useFactory/freeze-once pattern.
 *
 * Only the deterministic TEST_ECHO_AGENT_V1 is registered — this phase's
 * explicit scope boundary is the generic framework, never a real
 * Research/Blog/Video/etc. business agent (Part 20 of Phase 3.2's own
 * spec). A future phase adding the first real content agent registers
 * it here, alongside — not instead of — this one.
 */
@Global()
@Module({
  providers: [
    {
      provide: AGENT_REGISTRY,
      useFactory: (): AgentRegistry => {
        const builder = new AgentRegistryBuilder();
        // Module 4 Phase 4.1 — the first real business agent.
        builder.register(RESEARCH_AGENT_V1);
        // Module 6 Phase 6.2 — the Blog pipeline agents. Registered
        // identically here and in apps/worker's own AgentRegistryModule
        // (same @myev/shared objects — a per-process copy would risk
        // silent drift). apps/api validates the agent identifier at AI
        // job submission time; apps/worker executes it.
        builder.register(BLOG_BRIEF_AGENT_V1);
        builder.register(BLOG_OUTLINE_AGENT_V1);
        builder.register(BLOG_DRAFT_AGENT_V1);
        builder.register(SEO_METADATA_AGENT_V1);
        // Module 7 Phase 7.2 — the Video pipeline text agents. Registered
        // identically here and in apps/worker's own agent-registry.module.ts
        // (same @myev/shared objects) — api-worker-agent-registry-sync.spec.ts
        // proves the two module source files stay synchronized.
        builder.register(VIDEO_BRIEF_AGENT_V1);
        builder.register(VIDEO_SCRIPT_AGENT_V1);
        builder.register(VIDEO_SCENE_PLANNER_AGENT_V1);
        builder.register(VIDEO_SEO_METADATA_AGENT_V1);
        builder.register(THUMBNAIL_CONCEPT_AGENT_V1);
        builder.register(VIDEO_RECOMMENDATIONS_AGENT_V1);
        builder.register(TEST_ECHO_AGENT_V1);
        // Module 3 Phase 3.3 test-only fixtures — apps/api's own
        // AGENT_REGISTRY must know about these too (AiJobSubmissionService
        // validates the agent identifier here, at submission time, before
        // a job is ever durably enqueued for the worker's OWN identical
        // registration — see apps/worker's own agent-registry.module.ts).
        builder.register(TEST_FLAKY_AGENT_V1);
        builder.register(TEST_PERMANENT_FAIL_AGENT_V1);
        builder.register(TEST_TIMEOUT_AGENT_V1);
        return builder.freeze();
      },
    },
  ],
  exports: [AGENT_REGISTRY],
})
export class AgentRegistryModule {}
