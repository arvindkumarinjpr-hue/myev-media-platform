import { IsArray, IsIn, IsObject, IsOptional, IsString, IsUrl, MaxLength, MinLength } from "class-validator";

// FRD Appendix A, Database Design §5.3 — exact enum values.
export const KNOWLEDGE_SOURCE_TYPES = ["GOVERNMENT", "ASSOCIATION", "COMPANY", "PUBLICATION", "RSS"] as const;
export const KNOWLEDGE_PACK_CONTENT_TYPES = ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"] as const;

/**
 * Every child-collection item DTO below is nested inside
 * UpdateKnowledgePackDto — the 6 child tables have no `public_id` of
 * their own (Database Design §5.3), so they are never independently
 * addressable REST resources. Each collection, when supplied, wholesale
 * replaces the pack's current rows for that type — see
 * KnowledgePacksService.replaceChildCollections.
 */
export class KnowledgeSourceInputDto {
  @IsIn(KNOWLEDGE_SOURCE_TYPES)
  sourceType!: (typeof KNOWLEDGE_SOURCE_TYPES)[number];

  @IsUrl({}, { message: "url must be a valid URL." })
  url!: string;
}

export class PromptTemplateInputDto {
  @IsIn(KNOWLEDGE_PACK_CONTENT_TYPES)
  contentType!: (typeof KNOWLEDGE_PACK_CONTENT_TYPES)[number];

  @IsString()
  @MinLength(1)
  promptBody!: string;
}

export class SeoRuleInputDto {
  @IsOptional()
  @IsArray()
  primaryKeywords?: unknown[];

  @IsOptional()
  @IsArray()
  secondaryKeywords?: unknown[];

  @IsOptional()
  @IsObject()
  internalLinkingPolicy?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  schemaPreferences?: Record<string, unknown>;
}

export class BrandGuidelineInputDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  toneOfVoice?: string;

  @IsOptional()
  @IsObject()
  terminology?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  ctaRules?: string;

  @IsOptional()
  @IsString()
  logoAssetId?: string;
}

export class KeywordSetInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsArray()
  keywords!: unknown[];
}

export class CompetitorInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  domain!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
