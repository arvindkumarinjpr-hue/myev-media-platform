import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

/**
 * Module 6 Phase 6.3 — POST /blog input. `topic` + the EXACT Knowledge
 * Pack version are the only required inputs (FR-BLOG-001: "Topic required
 * as input"). `projectId` / `seriesId` are optional and only honoured
 * when the existing Module 1E model already supports them (it does — a
 * content item may carry both).
 */
export class CreateBlogDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  topic!: string;

  @IsUUID()
  knowledgePackVersionId!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  seriesId?: string;
}
