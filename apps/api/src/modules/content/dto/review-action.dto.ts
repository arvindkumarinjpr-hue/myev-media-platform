import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

// Shared 2000-char ceiling — Module 1E Engineering Plan "Review Comment
// Limit", mirrored by the content_review_events_comment_check DB
// constraint. Kept as a literal here (not read from ConfigService,
// DTOs aren't DI-constructed) — ContentItemsService re-validates against
// the configured value as the authoritative check; this bound only needs
// to be at least as strict so obviously-oversized input is rejected
// before it reaches the service.
const REVIEW_COMMENT_MAX_LENGTH = 2000;

export class SubmitForReviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment?: string;
}

export class ApproveContentDto {
  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment?: string;
}

// Required and non-empty at the DTO layer (MinLength(1) alone doesn't
// catch whitespace-only input — ContentItemsService re-validates the
// trimmed length, matching the DB CHECK's trim(comment) rule exactly).
export class RejectContentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment!: string;
}
