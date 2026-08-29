import { IsOptional, IsString, MaxLength, MinLength } from "class-validator";

// Mirrors Module 1E's review-action DTO bounds exactly — the Video
// module's submit/approve/reject endpoints delegate straight to
// ContentItemsService, which re-validates the comment against the
// configured limit as the authoritative check.
const REVIEW_COMMENT_MAX_LENGTH = 2000;

export class VideoSubmitForReviewDto {
  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment?: string;
}

export class VideoApproveDto {
  @IsOptional()
  @IsString()
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment?: string;
}

export class VideoRejectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(REVIEW_COMMENT_MAX_LENGTH)
  comment!: string;
}
