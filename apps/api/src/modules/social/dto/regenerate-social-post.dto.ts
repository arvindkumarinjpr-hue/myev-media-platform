import { IsUUID } from "class-validator";

/**
 * Module 10 Phase 10.3 — POST .../social-posts/:itemId/regenerate input.
 * No sourceContentItemId/platform here — Part G freezes regeneration to
 * the SocialPost's own already-pinned source/platform, never re-derived
 * or overridable per call. Only knowledgePackVersionId is re-suppliable,
 * mirroring createFromSource's own exact-version convention.
 */
export class RegenerateSocialPostDto {
  @IsUUID()
  knowledgePackVersionId!: string;
}
