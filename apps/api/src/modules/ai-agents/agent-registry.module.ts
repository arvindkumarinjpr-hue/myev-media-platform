import { Global, Module } from "@nestjs/common";
import { AgentRegistryBuilder, TEST_ECHO_AGENT_V1, TEST_FLAKY_AGENT_V1, TEST_PERMANENT_FAIL_AGENT_V1, TEST_TIMEOUT_AGENT_V1, type AgentRegistry } from "@myev/shared";

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
