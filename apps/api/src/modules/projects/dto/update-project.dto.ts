import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { SLUG_PATTERN } from "./create-project.dto";

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(63)
  @Matches(SLUG_PATTERN, { message: "slug must be lowercase alphanumeric, hyphen-separated." })
  slug?: string;

  // Phase 2.5 — explicit Project -> Knowledge Pack (Active version) FK
  // reassignment. Omitted = leave unchanged; null = unassign; a public_id
  // string = assign (resolved to the internal id server-side, ADR-013).
  // class-validator's @IsOptional() already treats null as a pass, same as
  // undefined, so no separate @ValidateIf is needed here.
  @IsOptional()
  @IsString()
  knowledgePackId?: string | null;
}
