import { ArrayMinSize, IsArray, IsISO8601, IsOptional, IsUUID } from "class-validator";

/**
 * Module 9 Phase 9.7 (Part N/P/Q) — the operator-facing "create a
 * publication" request body. Thin: `channelAccountPublicIds` (one or
 * more) + optional `scheduledFor` map directly onto
 * `PublishingPersistenceService.createPublication()`'s own existing
 * input shape (Phase 9.1) — this DTO adds no new fields that service
 * doesn't already accept, and no channel-specific options are collected
 * here (Part P: only truthful, provider-supported options — none of the
 * four connectors expose a publish-time option this DTO would need to
 * carry beyond what ContentItem.metadata.publishing already supplies via
 * the existing readiness/metadata pipeline).
 */
export class CreatePublicationDto {
  @IsUUID()
  contentItemPublicId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  channelAccountPublicIds!: string[];

  /** ISO 8601 — absent means "publish now" (Part Q: platform scheduler remains authoritative; no ambiguous browser-local time is ever accepted, this is always parsed/stored as an absolute UTC instant). */
  @IsOptional()
  @IsISO8601()
  scheduledFor?: string;
}
