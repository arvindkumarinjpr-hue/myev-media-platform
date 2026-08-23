import "reflect-metadata";
import { plainToInstance, type ClassConstructor } from "class-transformer";
import { validate } from "class-validator";
import { AIProviderError, AIProviderErrorCode } from "./ai-provider-error";

/**
 * Module 3 Phase 3.1 — provider-neutral structured-output handling.
 * Reuses class-validator/class-transformer (already the DTO-validation
 * convention throughout apps/api — not a new paradigm introduced here)
 * instead of adding a JSON-Schema library: the caller supplies a DTO
 * class, exactly like every existing request DTO in this codebase.
 * Never returns an unvalidated object — malformed JSON or a
 * schema-violating shape both become a normalized
 * MALFORMED_STRUCTURED_OUTPUT AIProviderError, never a silently-accepted
 * partial object.
 */
export async function parseStructuredOutput<T extends object>(rawText: string, schema: ClassConstructor<T>, provider: string): Promise<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new AIProviderError(AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT, "Provider returned output that is not valid JSON.", provider);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AIProviderError(AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT, "Provider returned JSON that is not an object.", provider);
  }

  const instance = plainToInstance(schema, parsed);
  const violations = await validate(instance, { whitelist: true, forbidNonWhitelisted: false });
  if (violations.length > 0) {
    throw new AIProviderError(
      AIProviderErrorCode.MALFORMED_STRUCTURED_OUTPUT,
      `Provider's structured output did not match the expected schema (${violations.length} violation(s)).`,
      provider,
    );
  }

  return instance;
}
