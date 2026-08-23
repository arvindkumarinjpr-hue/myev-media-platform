import type { ClassConstructor } from "class-transformer";

/**
 * Module 3 Phase 3.1 — the provider-neutral request contract.
 *
 * Field list matches the frozen Common/Standard Request Model exactly
 * (AI_PROVIDER_ABSTRACTION_LAYER_V1.0.md "Common Request Model";
 * API_AND_INTEGRATION_SPECIFICATION_V1.0.md §27 "Standard Input"):
 * Workspace ID, Project ID, Agent Name, Prompt, Context, Knowledge Pack,
 * Output Format, Temperature, Max Tokens.
 *
 * Two of those fields (Agent Name, Knowledge Pack) name business-domain
 * concepts that do not belong inside this layer's own logic (per this
 * phase's explicit boundary: no Blog/Video/Research-specific coupling,
 * and per the architecture diagram, the AI Orchestrator sits ABOVE this
 * layer and is the thing responsible for resolving a Knowledge Pack
 * version into concrete prompt content before calling here — see
 * knowledgePackReference below). Both are kept as opaque, optional
 * passthrough identifiers: present because the frozen spec requires the
 * field to exist on the contract, carried only for
 * correlation/audit/observability, and never interpreted, resolved, or
 * joined against anything by a provider adapter or the registry.
 */
export interface AIRequest {
  workspaceId: string;
  projectId?: string;

  /** Opaque label for observability/correlation only (e.g. "blog-agent") — never business logic inside this layer. Populated by whatever future orchestrator constructs the request. */
  agentName?: string;

  /** The fully-assembled prompt text/messages this request should execute. Already resolved — this layer does no prompt construction of its own. */
  prompt: string;
  /** Optional system-level instructions, kept separate from `prompt` since most provider SDKs distinguish system vs. user content. */
  systemInstructions?: string;

  /** Free-form resolved context (already-assembled brand voice, source excerpts, etc.) — never a Knowledge Pack foreign key or any raw Knowledge Pack row. */
  context?: Record<string, unknown>;
  /** Opaque passthrough only — see the module doc comment above. Never resolved by this layer. */
  knowledgePackReference?: string;

  /** Present only for a structured-output request — see structured-output.ts. Absent means plain text output. */
  outputFormat?: "text" | "json";
  /** Required when outputFormat === "json" — a class-validator DTO class, validated by structured-output.ts before the response is returned to the caller. */
  structuredOutputSchema?: ClassConstructor<object>;

  temperature?: number;
  maxTokens?: number;
  /** Milliseconds. A provider adapter must not exceed this even if the underlying SDK's own default is longer. */
  timeoutMs?: number;

  /** Ties this request to a caller-tracked unit of work (a future ai_job id, a log correlation id, etc.) — carried through into the response and every log line, never interpreted. */
  correlationId?: string;
  /** Free-form passthrough metadata for the caller's own observability needs — never inspected by this layer's own logic. */
  metadata?: Record<string, unknown>;
}
