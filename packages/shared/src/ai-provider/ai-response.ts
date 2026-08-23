/**
 * Module 3 Phase 3.1 — the provider-neutral response contract. Field
 * list matches the frozen Common/Standard Response Model exactly
 * (AI_PROVIDER_ABSTRACTION_LAYER_V1.0.md "Common Response Model";
 * API_AND_INTEGRATION_SPECIFICATION_V1.0.md §27 "Standard Output"):
 * Provider, Model, Request ID, Output, Token Usage, Cost Estimate,
 * Execution Time, Confidence (optional).
 *
 * Every adapter maps its own SDK's response into exactly this shape — no
 * raw provider SDK object is ever returned through this layer (a
 * business module must never need to know provider-specific response
 * shapes).
 */
export interface AITokenUsage {
  tokensIn: number;
  tokensOut: number;
  tokensTotal: number;
}

export type AIFinishReason = "stop" | "length" | "content_filter" | "tool_call" | "unknown";

export interface AIResponse {
  provider: string;
  model: string;
  /** The provider's own request/trace id, when the SDK exposes one — for cross-referencing provider-side logs. */
  requestId: string;

  /** Plain text output, or the schema-validated parsed object when the request specified outputFormat: "json" (see structured-output.ts) — never a raw unvalidated string in the JSON case. */
  output: string | Record<string, unknown>;

  usage: AITokenUsage;
  /** Absent when the provider/model's cost_per_unit hasn't been configured — never a fabricated estimate. */
  costEstimate?: number;

  executionTimeMs: number;
  finishReason: AIFinishReason;
  /** Only when the provider surfaces one (e.g. some structured-output/classification calls) — absent otherwise, never invented. */
  confidence?: number;

  correlationId?: string;
}
