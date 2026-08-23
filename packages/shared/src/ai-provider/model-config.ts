/**
 * Module 3 Phase 3.1 — model configuration, kept separate from business
 * workflow entirely (AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §5.5
 * `ai_models`: provider_id, model_name, capability, cost_per_unit —
 * platform-level, not workspace-scoped). This phase defines the shape
 * and the merge rule only; persisting/administering these values (a DB
 * table + seed data vs. a future admin UI) is intentionally out of scope
 * here — no provider-management UI is being built in this phase.
 */
export interface GenerationDefaults {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ModelConfig {
  provider: string;
  model: string;
  defaults: GenerationDefaults;
}

/**
 * Runtime overrides win field-by-field over configured defaults; an
 * omitted override field falls back to the default. Pure — never
 * mutates `config.defaults`, so the same ModelConfig object can be
 * reused safely across many requests with different per-call overrides.
 */
export function resolveGenerationSettings(config: ModelConfig, overrides: GenerationDefaults = {}): Required<GenerationDefaults> {
  return {
    temperature: overrides.temperature ?? config.defaults.temperature ?? 0.7,
    maxTokens: overrides.maxTokens ?? config.defaults.maxTokens ?? 2048,
    timeoutMs: overrides.timeoutMs ?? config.defaults.timeoutMs ?? 30_000,
  };
}
