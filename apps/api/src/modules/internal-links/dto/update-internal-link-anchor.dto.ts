import { IsString, MaxLength, MinLength } from "class-validator";

// Mirrors BlogRejectDto's bound style. The richer semantic rules (no
// URL, no punctuation-only, no invalid whitespace) are enforced by
// validateHumanAnchorText() at the service layer — the authoritative
// check, same "DTO bound + service-level re-check" convention as the
// Blog module's own review-comment DTOs.
const ANCHOR_TEXT_MAX_LENGTH = 60;

export class UpdateInternalLinkAnchorDto {
  @IsString()
  @MinLength(1)
  @MaxLength(ANCHOR_TEXT_MAX_LENGTH)
  anchorText!: string;
}
