import { BadRequestException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";
import type { SupportedContentType } from "./content-permission.resolver";

/**
 * Module 1E Engineering Plan's Body Validation Contract. `body` is opaque
 * JSONB once accepted — this is the one place that ever looks inside it.
 * Runs BEFORE a version is written, on both create and every subsequent
 * version (an edit always inserts a new immutable version, never mutates
 * one — see content_versions' model comment).
 */
const DATA_URI_PREFIX = /^data:[a-zA-Z0-9!#$&.+\-^_]+\/[a-zA-Z0-9!#$&.+\-^_]+;base64,/;
// Requires a multiple-of-4 length as part of the pattern match itself
// (\1 back-check via length%4 is done separately, not expressible in the
// regex) — see isLikelyBase64Payload below.
const BASE64_ALPHABET_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;

function isLikelyBase64Payload(value: string, minLength: number): boolean {
  if (value.length < minLength) return false;
  if (value.length % 4 !== 0) return false;
  return BASE64_ALPHABET_ONLY.test(value);
}

@Injectable()
export class ContentBodyValidator {
  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  validate(contentType: SupportedContentType, body: unknown): void {
    const limits = this.config.get("content", { infer: true });

    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new BadRequestException({ code: "CONTENT_BODY_INVALID", message: "body must be a JSON object." });
    }

    const serialized = JSON.stringify(body);
    const sizeBytes = Buffer.byteLength(serialized, "utf8");
    if (sizeBytes > limits.maxBodySizeBytes) {
      throw new BadRequestException({
        code: "CONTENT_BODY_TOO_LARGE",
        message: `body exceeds the maximum size of ${limits.maxBodySizeBytes} bytes.`,
      });
    }

    this.walk(body, 1, limits.maxBodyDepth, limits.maxStringValueLength, limits.base64HeuristicMinLength);
    this.validateShape(contentType, body as Record<string, unknown>);
  }

  /**
   * Depth/string-length/binary-smuggling sweep over the whole structure.
   * Depth counts object/array nesting only (Module 1E Engineering Plan:
   * "prevent pathological deeply-nested JSON").
   */
  private walk(value: unknown, depth: number, maxDepth: number, maxStringLength: number, base64MinLength: number): void {
    if (depth > maxDepth) {
      throw new BadRequestException({ code: "CONTENT_BODY_TOO_DEEP", message: `body exceeds the maximum nesting depth of ${maxDepth}.` });
    }

    if (typeof value === "string") {
      if (value.length > maxStringLength) {
        throw new BadRequestException({
          code: "CONTENT_BODY_STRING_TOO_LONG",
          message: `A string field exceeds the maximum length of ${maxStringLength} characters.`,
        });
      }
      // Tier 2: explicit data-URI scheme prefix — cheap, precise, applies
      // at any length.
      if (DATA_URI_PREFIX.test(value)) {
        throw new BadRequestException({
          code: "CONTENT_BODY_BINARY_CONTENT_DETECTED",
          message: "body must not contain embedded binary content (data URIs). Upload it as a media asset instead.",
        });
      }
      // Tier 3: base64-alphabet pattern match, narrowed to strings at or
      // above base64MinLength to avoid false positives on short ids/slugs
      // that incidentally satisfy the character class.
      if (isLikelyBase64Payload(value, base64MinLength)) {
        throw new BadRequestException({
          code: "CONTENT_BODY_BINARY_CONTENT_DETECTED",
          message: "body must not contain embedded binary content (base64-encoded data). Upload it as a media asset instead.",
        });
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) this.walk(item, depth + 1, maxDepth, maxStringLength, base64MinLength);
      return;
    }

    if (value !== null && typeof value === "object") {
      for (const nested of Object.values(value as Record<string, unknown>)) {
        this.walk(nested, depth + 1, maxDepth, maxStringLength, base64MinLength);
      }
    }
  }

  /**
   * Minimal per-type shape — just enough to guarantee downstream
   * consumers (a future Blog/Video rendering module) have something to
   * work with, not a full schema. BLOG mirrors blog_articles' eventual
   * body text; VIDEO mirrors video_scripts.script_body (AI_CONTENT_
   * DATABASE_AND_ENTITY_DESIGN_V1.0.md §content_items extension tables).
   * SOCIAL_POST mirrors social_posts' own caption field (Module 10 Phase
   * 10.2) — added as its own branch, not folded into VIDEO's "script"
   * fallback, now that a third supported content type exists.
   */
  private validateShape(contentType: SupportedContentType, body: Record<string, unknown>): void {
    const field = contentType === "BLOG" ? "content" : contentType === "SOCIAL_POST" ? "caption" : "script";
    const value = body[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new BadRequestException({
        code: "CONTENT_BODY_MISSING_REQUIRED_FIELD",
        message: `${contentType} content requires a non-empty "${field}" string field in body.`,
      });
    }
  }
}
