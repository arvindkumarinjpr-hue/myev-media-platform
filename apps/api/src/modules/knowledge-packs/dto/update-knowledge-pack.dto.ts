import { Type } from "class-transformer";
import { IsArray, IsInt, IsObject, IsOptional, IsString, Min, MaxLength, MinLength, ValidateNested } from "class-validator";
import {
  BrandGuidelineInputDto,
  CompetitorInputDto,
  KeywordSetInputDto,
  KnowledgeSourceInputDto,
  PromptTemplateInputDto,
  SeoRuleInputDto,
} from "./knowledge-pack-child.dto";

/**
 * Draft-only (KnowledgePacksService.update rejects non-Draft packs —
 * MODULE_2_KNOWLEDGE_PACK_ARCHITECTURE_V1.0.md §7/§12: only a Draft is
 * mutable in place). expectedLockVersion is mandatory — root-only
 * aggregate optimistic concurrency (ADR-014 §10), never optional, so a
 * caller can never accidentally overwrite a concurrent edit by omitting
 * it. Any child collection that is supplied wholesale replaces the
 * pack's current rows for that type; an omitted collection is left
 * untouched.
 */
export class UpdateKnowledgePackDto {
  @IsInt()
  @Min(1)
  expectedLockVersion!: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsObject()
  industryProfile?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  publishingStrategy?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KnowledgeSourceInputDto)
  sources?: KnowledgeSourceInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PromptTemplateInputDto)
  promptTemplates?: PromptTemplateInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SeoRuleInputDto)
  seoRules?: SeoRuleInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BrandGuidelineInputDto)
  brandGuidelines?: BrandGuidelineInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KeywordSetInputDto)
  keywordSets?: KeywordSetInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CompetitorInputDto)
  competitors?: CompetitorInputDto[];
}
