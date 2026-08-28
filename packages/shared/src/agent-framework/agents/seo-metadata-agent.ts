import "reflect-metadata";
import { IsArray, IsObject, IsString, Matches, MinLength } from "class-validator";
import type { AgentContext } from "../agent-context";
import type { AgentDefinition } from "../agent-definition";

/**
 * Module 6 Phase 6.2 — SEO Metadata Agent
 * (BLOG_AUTOMATION_ENGINE_V1.0.md "4. SEO Engine"; FRD FR-BLOG-004 +
 * FR-SEO-001/FR-SEO-002).
 *
 * Produces ONLY the frozen SEO metadata set that DB Design §5.4's
 * `blog_articles` extension row stores: meta_title, meta_description,
 * url_slug, schema_markup (JSONB). Nothing else.
 *
 * FR-BLOG-004's own validation note: "Meta title/description length
 * limits (values TBD in expanded SEO spec — open item)." No frozen
 * numeric limit exists, so the output schema enforces only non-empty
 * strings + a well-formed kebab-case slug + a schema object with an
 * @type. Malformed output therefore fails schema validation and the job
 * fails safely — it is never silently "fixed" into a fabricated value.
 *
 * FRD §21.1 frozen timeout — "Queue job timeout — SEO/Internal Linking
 * pass | 3 min" — applied as `timeoutMs: 180_000`.
 */

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class SeoMetadataAgentInput {
  @IsString()
  @MinLength(1)
  topic!: string;

  /** The drafted article's H1 / working title. */
  @IsString()
  @MinLength(1)
  title!: string;

  @IsString()
  @MinLength(1)
  primaryKeyword!: string;

  @IsArray()
  @IsString({ each: true })
  secondaryKeywords!: string[];

  /** A short summary of the article body, or its intro — enough context
   * to write a meta description. */
  @IsString()
  @MinLength(1)
  articleSummary!: string;
}

export class SeoMetadataAgentOutput {
  @IsString()
  @MinLength(1)
  metaTitle!: string;

  @IsString()
  @MinLength(1)
  metaDescription!: string;

  /** Lowercase, hyphen-separated. Structural validation only — no frozen
   * length limit. */
  @IsString()
  @Matches(SLUG_PATTERN, { message: "urlSlug must be lowercase words separated by single hyphens" })
  urlSlug!: string;

  /** A schema.org JSON-LD suggestion (FR-SEO-002). Must be an object;
   * `postProcessOutput` additionally requires a non-empty `@type`. */
  @IsObject()
  schemaMarkup!: Record<string, unknown>;
}

function buildPrompt(input: SeoMetadataAgentInput, context: AgentContext): { prompt: string; systemInstructions: string } {
  const seoRules = context.seoRules.length > 0 ? JSON.stringify(context.seoRules) : "";

  const systemInstructions = [
    "You are the SEO Metadata Agent for an EV (electric vehicle) content platform.",
    "Given a finished blog article's title, keywords, and summary, produce exactly four things: a meta title, a meta description, a URL slug, and a schema.org JSON-LD markup object.",
    "The meta title should lead with or include the primary keyword and read naturally. The meta description should summarise the article and invite a click. The slug must be lowercase words separated by single hyphens, derived from the primary keyword / title, with no stop-word padding.",
    "The schema markup must be a valid schema.org JSON-LD object with an \"@type\" (\"Article\" for a blog post) and a \"headline\"; include only fields you can fill from the given information.",
    "Do not invent an author, a publish date, an image URL, or an organisation you were not given.",
    seoRules ? `KNOWLEDGE PACK SEO RULES: ${seoRules}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = [
    `Topic: ${input.topic}`,
    `Article title: ${input.title}`,
    `Primary keyword: ${input.primaryKeyword}`,
    input.secondaryKeywords.length > 0 ? `Secondary keywords: ${input.secondaryKeywords.join(", ")}` : "",
    `Article summary: ${input.articleSummary}`,
    "",
    'Respond with a single JSON object matching SeoMetadataAgentOutput exactly: metaTitle, metaDescription, urlSlug, schemaMarkup (a schema.org JSON-LD object with "@type" and "headline").',
  ]
    .filter(Boolean)
    .join("\n");

  return { prompt, systemInstructions };
}

/**
 * Deterministic structural check the class-validator decorators can't
 * express: `schemaMarkup` must actually be a non-empty object that names
 * an `@type`. Runs as the post-process hook on the already
 * schema-validated output — throws (→ job fails safely) rather than
 * "repairing" a bad value.
 */
function postProcessOutput(output: SeoMetadataAgentOutput): SeoMetadataAgentOutput {
  const schema = output.schemaMarkup;
  const type = (schema as Record<string, unknown>)["@type"];
  if (typeof type !== "string" || type.trim().length === 0) {
    throw new Error('SEO metadata schemaMarkup must be a schema.org object with a non-empty string "@type"');
  }
  return output;
}

export const SEO_METADATA_AGENT_V1: AgentDefinition<SeoMetadataAgentInput, SeoMetadataAgentOutput> = {
  identifier: "seo-metadata-agent",
  version: 1,
  purpose: "Generates the frozen SEO metadata set (meta title, meta description, URL slug, schema.org markup) for a finished blog article — FR-BLOG-004 / FR-SEO-001 / FR-SEO-002.",
  type: "seo",
  requiredKnowledgePackCapability: "seo_rules",
  providerPreference: { provider: "openai", model: "gpt-4o" },
  inputSchema: SeoMetadataAgentInput,
  outputSchema: SeoMetadataAgentOutput,
  buildPrompt,
  postProcessOutput,
  // FROZEN — FRD §21.1 "Queue job timeout — SEO/Internal Linking pass | 3 min".
  timeoutMs: 180_000,
  executionPolicy: { maxAttempts: 3 },
};
