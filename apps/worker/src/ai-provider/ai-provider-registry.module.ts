import { Global, Module } from "@nestjs/common";
import { AIProviderRegistryBuilder, FakeProvider, type AIProviderRegistry } from "@myev/shared";

export const AI_PROVIDER_REGISTRY = Symbol("AI_PROVIDER_REGISTRY");

/**
 * Module 3 Phase 3.3 — this worker process's own AIProviderRegistry,
 * mirroring apps/api's AiProviderRegistryModule exactly (same
 * @Global/useFactory/freeze-once pattern already established for
 * QueueRegistryModule on both processes). A separate DI-container
 * registration is unavoidable — apps/worker and apps/api are separate
 * NestJS processes and neither imports the other's compiled providers
 * (Module 1F's own firm boundary: apps/api never executes jobs, only
 * apps/worker does) — but both processes register the identical
 * packages/shared building blocks, so there is no duplicated business
 * logic, only DI bootstrap wiring, the same shape QueueRegistryModule
 * itself already has on both sides.
 *
 * Only FakeProvider is registered — see apps/api's own identical module
 * for the full rationale (no real business agent exists yet that needs a
 * real provider).
 */
@Global()
@Module({
  providers: [
    {
      provide: AI_PROVIDER_REGISTRY,
      useFactory: (): AIProviderRegistry => {
        const builder = new AIProviderRegistryBuilder();
        builder.register(new FakeProvider("structured_success", { echo: "test-echo-agent-default-response" }));
        // Module 3 Phase 3.3 test-only fixtures — deterministic
        // retry/permanent-failure/timeout proof against this real,
        // already-running worker process, mirroring the existing
        // precedent of test-only fixture hooks living directly in a
        // production registration (e.g. SystemPingPayload's own
        // failUntilAttempt/permanentFailure). Distinct FakeProvider ids,
        // never "fake" — see FakeProvider's own id-configurability
        // rationale.
        builder.register(new FakeProvider("flaky_then_success", {}, 1, "fake-flaky"));
        builder.register(new FakeProvider("permanent_error", {}, 1, "fake-permanent"));
        builder.register(new FakeProvider("timeout", {}, 1, "fake-timeout"));
        return builder.freeze();
      },
    },
  ],
  exports: [AI_PROVIDER_REGISTRY],
})
export class AiProviderRegistryModule {}
