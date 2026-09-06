import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from "class-validator";

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

  /**
   * Module 10 Phase 10.5 — the MediaAsset to attach to the NEW version
   * this edit creates. Undefined = leave whatever the current version has
   * unchanged. Explicit `null` = detach media (Facebook remains valid
   * caption-only; Instagram readiness becomes not-ready). A real publicId
   * = attach/replace — SocialService.edit() validates it resolves to a
   * same-workspace, ACTIVE MediaAsset before writing anything.
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  mediaAssetPublicId?: string | null;
}
