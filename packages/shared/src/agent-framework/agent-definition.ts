import type { ClassConstructor } from "class-transformer";
import type { AgentContext } from "./agent-context";

/**
 * Module 3 Phase 3.2 — the generic Agent definition contract
 * (AI_AGENT_FRAMEWORK_V1.0.md's Agent Catalog + Design Principles:
 * Single Responsibility per Agent, Knowledge Pack Driven, Provider
 * Independent). This is a compile-time/bootstrap-time construct — like
 * ProcessorManifest (@myev/shared/queue) — never a DB table; only the
 * resolved `identifier`/`version` a job actually ran with is persisted
 * (see AiJob.agentName/agentVersion in apps/api's schema).
 *
 * No production content agent (Research/Blog/Video/etc.) is defined
 * here — this phase's own scope boundary is the generic framework, not
 * the Agent Catalog's 15 named agents. See FakeTestAgent for the one
 * deterministic, test-only definition this phase does register.
 */
export interface AgentDefinition<TInput extends object = object, TOutput extends object = object> {
  /** Stable registry key — e.g. "test-echo-agent". Never a display name. */
  readonly identifier: string;
  /** Monotonically increasing per identifier. Every execution records the exact version it ran with (Part 4/9's reproducibility requirement) — never implicitly "latest" behind the caller's back once persisted. */
  readonly version: number;

  /** One-line description of what this agent does — not a business capability list; a real content agent's own doc, not this framework's concern. */
  readonly purpose: string;
  /** Free-form classification (e.g. "test", "research", "content-generation") — introspection only, never branches execution logic. */
  readonly type: string;

  /**
   * Optional — a capability tag this agent expects its Knowledge Pack to
   * satisfy (e.g. "seo_rules", "brand_guidelines"). Advisory metadata
   * only in this phase: AgentExecutor enforces the ADR-004 gate (an
   * ACTIVE Knowledge Pack must exist) uniformly for every agent, but does
   * not yet validate pack *contents* against this tag — no capability
   * taxonomy has been designed/frozen yet, and inventing one here would
   * be exactly the kind of un-sourced architecture this phase must not
   * add.
   */
  readonly requiredKnowledgePackCapability?: string;

  /** Which provider/model this agent prefers, resolved through the Phase 3.1 AIProviderRegistry — never a raw vendor SDK reference. */
  readonly providerPreference: { provider: string; model: string };

  /** class-validator DTO the caller's `input` must satisfy — validated before any provider call is made. */
  readonly inputSchema: ClassConstructor<TInput>;
  /** Absent means plain-text output; present means every execution's output is schema-validated via structured-output.ts (Phase 3.1), never silently accepted unvalidated. */
  readonly outputSchema?: ClassConstructor<TOutput>;

  /**
   * The one piece of genuinely agent-specific logic the generic
   * AgentExecutor delegates outward — turning this agent's own validated
   * input plus the resolved AgentContext into the actual prompt text
   * (and optional system instructions) a provider call needs. Keeps
   * "Single Responsibility per Agent" (AI_AGENT_FRAMEWORK_V1.0.md) intact:
   * the executor never guesses how to phrase any particular agent's
   * request.
   */
  // Method-shorthand syntax deliberately, not a `readonly` arrow-function
  // property: TypeScript checks method parameters bivariantly, which is
  // what lets a registry hold heterogeneous `AgentDefinition<Specific,
  // ...>` values under one non-generic `AgentDefinition` type without
  // resorting to `any`. An arrow-typed property here would make this
  // interface contravariant in TInput and break exactly that.
  buildPrompt(input: TInput, context: AgentContext): { prompt: string; systemInstructions?: string };

  /** Milliseconds — passed through to the AIRequest's own timeoutMs (Phase 3.1's provider-execution boundary), not a second independent timeout mechanism. */
  readonly timeoutMs: number;

  /**
   * Describes this agent's retry posture for a FUTURE durable-dispatch
   * caller (Module 1F's Queue Engine) — this phase's own AgentExecutor
   * never retries internally (ADR-005: retry belongs to the async job
   * layer, not the executor), so these numbers are inert metadata here,
   * carried through for whenever real durable dispatch is designed.
   */
  readonly executionPolicy: { maxAttempts: number };

  readonly metadata?: Record<string, unknown>;
}
