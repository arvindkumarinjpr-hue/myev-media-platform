import { IsString, MaxLength, MinLength } from "class-validator";

// Mirrors BlogRejectDto exactly — reject requires a meaningful,
// non-empty reason (Phase 8.4 architecture §J).
const REJECTION_REASON_MAX_LENGTH = 2000;

export class RejectInternalLinkDto {
  @IsString()
  @MinLength(1)
  @MaxLength(REJECTION_REASON_MAX_LENGTH)
  rejectionReason!: string;
}
