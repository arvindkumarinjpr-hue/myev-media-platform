/**
 * Module 6 Phase 6.1 — the normalized, provider-neutral view of a piece
 * of content that the scoring engine and every dimension read.
 *
 * The engine and the dimensions never touch Prisma, an HTTP request, a
 * Knowledge Pack row, or Module 1E's opaque `content_versions.body`
 * JSON directly. The API layer (apps/api's ScoringInputBuilder) does all
 * of that resolution/normalization and hands in one of these. That
 * boundary is what keeps `@myev/shared` free of any app-specific
 * dependency and keeps this engine unit-testable with a plain object.
 *
 * Every field is optional except `contentType` and `title`: a dimension
 * scores what it is given and produces a low factor value + a
 * recommendation for what is missing — it never throws on absent input.
 */
export interface ScoringInput {
  /** The frozen ContentType this content is — drives which dimension the
   * engine resolves. Same vocabulary as FRD Appendix A / Prisma
   * `ContentType`, kept as a bare string here so `@myev/shared` need not
   * depend on the Prisma-generated enum. */
  readonly contentType: string;

  /** Display/heading title of the piece. */
  readonly title: string;

  /** Full body as plain text, best-effort flattened from whatever shape
   * Module 1E stored (`body.content` / markdown / joined sections). */
  readonly bodyText?: string;

  /** Ordered heading outline, each with its level (1 = H1). Empty when
   * no structure could be extracted. */
  readonly headings?: ReadonlyArray<{ readonly level: number; readonly text: string }>;

  /** Distinct wording of FAQ questions found in the content. */
  readonly faqQuestions?: readonly string[];

  /** Internal links (to other workspace content) discovered in the body. */
  readonly internalLinkCount?: number;

  /** External / outbound links discovered in the body. */
  readonly externalLinkCount?: number;

  /** References to embedded media (images, video) in the body. */
  readonly mediaReferenceCount?: number;

  /** SEO metadata already set on the content, when present. */
  readonly metadata?: {
    readonly metaTitle?: string;
    readonly metaDescription?: string;
    readonly urlSlug?: string;
    readonly hasSchemaMarkup?: boolean;
  };

  /** Target keywords for this piece — from the workspace's active
   * Knowledge Pack keyword sets, or an explicit brief. Absent/empty
   * means keyword-alignment factors score low with a "no target
   * keywords available" reason, never an error. */
  readonly targetKeywords?: readonly string[];

  /** Primary keyword, when one is designated (else the first
   * targetKeyword is treated as primary). */
  readonly primaryKeyword?: string;

  /** Brand / product terms from the active Knowledge Pack's brand
   * guidelines — used by Business/brand-consistency factors. */
  readonly brandTerms?: readonly string[];

  /** True when the workspace has an ACTIVE Knowledge Pack backing this
   * score. When false, keyword/brand factors still run but the engine's
   * dimensions add a recommendation noting the reduced confidence. */
  readonly knowledgePackActive: boolean;
}
