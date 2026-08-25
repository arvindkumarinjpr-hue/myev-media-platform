import { Global, Module } from "@nestjs/common";
import { AgentRegistryBuilder, TEST_ECHO_AGENT_V1, TEST_FLAKY_AGENT_V1, TEST_PERMANENT_FAIL_AGENT_V1, TEST_TIMEOUT_AGENT_V1, type AgentRegistry } from "@myev/shared";

export const AGENT_REGISTRY = Symbol("AGENT_REGISTRY");

/**
 * Module 3 Phase 3.3 — this worker process's own AgentRegistry, mirroring
 * apps/api's AgentRegistryModule exactly — see AiProviderRegistryModule's
 * own doc comment in this same directory for why a second DI-container
 * registration (not a second implementation) is the correct shape here.
 *
 * Only TEST_ECHO_AGENT_V1 is registered — no real business agent exists
 * yet (Part 24 of this phase's own spec).
 */
@Global()
@Module({
  providers: [
    {
      provide: AGENT_REGISTRY,
      useFactory: (): AgentRegistry => {
        const builder = new AgentRegistryBuilder();
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
