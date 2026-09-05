import { ArrayMaxSize, IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * Module 10 Phase 10.3 — PATCH .../social-posts/:itemId input. A human
 * edit, never AI-touching. All fields optional (true PATCH semantics):
 * an omitted field keeps its current value from the item's own current
 * ContentVersion body; SocialService.edit() merges before validating.
 * hashtags may be an empty array (Part L: "empty array should remain
 * valid unless architecture says otherwise" — the generic
 * ContentBodyValidator's own SOCIAL_POST shape check never required a
 * non-empty hashtags array).
 */
export class EditSocialPostDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  caption?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  hashtags?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  ctaObjective?: string;
}
