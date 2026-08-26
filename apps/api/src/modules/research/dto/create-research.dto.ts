import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from "class-validator";

/**
 * Module 4 Phase 4.1 — the user-facing Research request shape. Never
 * accepts verifiedSources or any other agent-internal field directly —
 * ResearchService resolves those itself from the Knowledge Pack's own
 * Trusted Sources (FR-RES-002), a caller can only choose what to
 * research, not what it may cite.
 */
export class CreateResearchDto {
  @IsString()
  @IsNotEmpty()
  topic!: string;

  // The EXACT Knowledge Pack version's public id — never "the
  // workspace's active pack", resolved implicitly (Module 2/3's own
  // non-substitution principle, reused verbatim here).
  @IsUUID()
  knowledgePackVersionId!: string;

  @IsOptional()
  @IsString()
  objective?: string;

  @IsOptional()
  @IsString()
  geography?: string;

  @IsOptional()
  @IsString()
  language?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  seedKeywords?: string[];
}
