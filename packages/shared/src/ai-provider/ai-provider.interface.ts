import type { AIRequest } from "./ai-request";
import type { AIResponse } from "./ai-response";

/**
 * A single model this provider can serve, for registry introspection
 * only (AI_CONTENT_DATABASE_AND_ENTITY_DESIGN_V1.0.md §5.5's `ai_models`
 * shape: provider, model_name, capability, cost_per_unit) — never used
 * by an adapter to route a request; the model to call is always
 * whatever the caller specified.
 */
export interface AIModelCapability {
  model: string;
  capability: "chat" | "structured_output" | "image_generation" | "image_understanding" | "speech_to_text" | "text_to_speech" | "embeddings" | "document_analysis";
  costPerUnit?: number;
}

/**
 * Module 3 Phase 3.1 — the adapter contract every provider implements.
 * Deliberately minimal: one execution method plus capability
 * introspection. No Nest decorators, no BullMQ types, no vendor SDK
 * types anywhere in this file — an adapter's own module is where the
 * vendor SDK is imported, never here.
 */
export interface AIProvider {
  /** Stable identifier this provider registers under — e.g. "openai", "anthropic", "gemini". Never a display name, never versioned. */
  readonly id: string;

  /**
   * Executes one request against this provider, returning the
   * normalized AIResponse. Must throw AIProviderError (never a raw SDK
   * error) on any failure. `signal`, when provided, aborts the
   * in-flight call — this is the only cancellation mechanism this layer
   * defines; there is no separate background-job lifecycle here (Module
   * 1's Queue Engine remains authoritative for durable async execution).
   */
  execute(request: AIRequest, signal?: AbortSignal): Promise<AIResponse>;

  /** Registry introspection only — never used by execute() itself to pick a model. */
  getCapabilities(): AIModelCapability[];
}
