/**
 * Module 9 Phase 9.3 — the one error type every shared Publishing
 * business-rule function throws, mirroring AgentExecutionResolutionError's
 * exact shape (packages/shared/src/agent-framework/agent-execution-
 * resolver.ts): a plain Error subclass, never a NestJS HttpException and
 * never a BullMQ-specific type, so this package stays framework-free.
 * Each process's own call site catches this and translates `code`/
 * `message` into whatever its own error idiom requires — apps/api into a
 * typed HttpException, apps/worker into a retryable Error or a
 * PermanentProcessorError.
 */
export class PublishingDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublishingDomainError";
  }
}
