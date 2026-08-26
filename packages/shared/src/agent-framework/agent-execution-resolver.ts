import { AIProviderRegistryValidationError, type AIProviderRegistry } from "../ai-provider/ai-provider-registry";
import type { AIProvider } from "../ai-provider/ai-provider.interface";
import type { GenerationDefaults } from "../ai-provider/model-config";
import type { AgentDefinition } from "./agent-definition";
import { AgentExecutionErrorCode, type AgentExecutionFailure } from "./agent-execution-error";

/** Carries a fully-formed AgentExecutionFailure so a catch site never has to re-derive `messageSafe`/`code` from a generic Error. */
export class AgentExecutionResolutionError extends Error {
  constructor(public readonly failure: AgentExecutionFailure) {
    super(failure.messageSafe);
    this.name = "AgentExecutionResolutionError";
  }
}

export interface ResolvedAgentExecution {
  provider: AIProvider;
  model: string;
  /** Only the fields actually resolved (agent preference merged with caller overrides) — an untouched field stays undefined so the provider adapter's own configured defaults still apply; never a forced value. */
  generationSettings: GenerationDefaults;
}

/**
 * Module 3 Phase 3.5 — the ONE place that turns an AgentDefinition plus
 * optional caller-supplied runtime overrides into an exact, resolved
 * provider + model + generation-settings bundle. Replaces what was
 * previously two separate inline `providerRegistry.resolve(...)` calls
 * (one in AgentExecutorService, one in AiExecuteProcessor) that had NO
 * error handling at all — an unconfigured provider threw an uncaught
 * AIProviderRegistryValidationError past the point the ai_jobs row
 * already existed, and in the durable path specifically, past the
 * atomic RUNNING claim too, leaving the row stuck RUNNING forever (the
 * next redelivery's own claim step would see `status !== "QUEUED"` and
 * silently no-op, reporting false BullMQ success). This resolver turns
 * that into a clean, classified AgentExecutionResolutionError instead.
 *
 * Caller-supplied `overrides` win field-by-field over the agent's own
 * `executionPolicy.generationDefaults` — a pure, type-constrained merge
 * (GenerationDefaults has exactly three numeric fields: temperature,
 * maxTokens, timeoutMs), which is itself the security boundary Part 13
 * of this phase's own spec asks for: no override can ever inject a
 * credential, a provider id, or anything beyond those three numbers.
 */
export function resolveAgentExecution(definition: AgentDefinition, providerRegistry: AIProviderRegistry, overrides: GenerationDefaults = {}): ResolvedAgentExecution {
  let provider: AIProvider;
  try {
    provider = providerRegistry.resolve(definition.providerPreference.provider);
  } catch (err) {
    if (err instanceof AIProviderRegistryValidationError) {
      throw new AgentExecutionResolutionError({
        code: AgentExecutionErrorCode.PROVIDER_NOT_CONFIGURED,
        messageSafe: `Agent "${definition.identifier}" requires provider "${definition.providerPreference.provider}", which is not configured in this environment.`,
      });
    }
    throw err;
  }

  const generationSettings: GenerationDefaults = {
    ...definition.executionPolicy.generationDefaults,
    ...overrides,
  };

  return { provider, model: definition.providerPreference.model, generationSettings };
}
