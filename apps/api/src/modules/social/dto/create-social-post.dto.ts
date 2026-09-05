import { IsIn, IsUUID } from "class-validator";

/**
 * Module 10 Phase 10.2 — POST .../social-posts input. `sourceContentItemId`
 * is the public id of an already-Approved BLOG or VIDEO content item in
 * this workspace (SocialGenerationService enforces eligibility — this DTO
 * only shapes the request). `knowledgePackVersionId` mirrors CreateBlogDto's
 * own exact-version, ADR-004 non-substitution convention.
 */
export class CreateSocialPostDto {
  @IsUUID()
  sourceContentItemId!: string;

  @IsIn(["FACEBOOK", "INSTAGRAM"])
  platform!: "FACEBOOK" | "INSTAGRAM";

  @IsUUID()
  knowledgePackVersionId!: string;
}
