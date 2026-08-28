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
  type AgentRegistry,
} from "@myev/shared";

export const AGENT_REGISTRY = Symbol("AGENT_REGISTRY");

/**
 * Module 3 Phase 3.3 — this worker process's own AgentRegistry, mirroring
 * apps/api's AgentRegistryModule exactly — see AiProviderRegistryModule's
 * own doc comment in this same directory for why a second DI-container
 * registration (not a second implementation) is the correct shape here.
 *
 * Module 4 Phase 4.1: RESEARCH_AGENT_V1 is the first real business
 * agent registered here, alongside — not instead of — the test-only
 * fixtures below (still needed by Module 3's own regression suite).
 */
@Global()
@Module({
  providers: [
    {
      provide: AGENT_REGISTRY,
      useFactory: (): AgentRegistry => {
        const builder = new AgentRegistryBuilder();
        builder.register(RESEARCH_AGENT_V1);
        // Module 6 Phase 6.2 — the Blog pipeline agents, registered
        // identically to apps/api's AgentRegistryModule (same
        // @myev/shared objects). The generic AiExecuteProcessor executes
        // them — no new queue, no new processor.
        builder.register(BLOG_BRIEF_AGENT_V1);
        builder.register(BLOG_OUTLINE_AGENT_V1);
        builder.register(BLOG_DRAFT_AGENT_V1);
        builder.register(SEO_METADATA_AGENT_V1);
        builder.register(TEST_ECHO_AGENT_V1);
        // Module 3 Phase 3.3 test-only fixtures — see
        // ai-provider-registry.module.ts's own doc comment.
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
