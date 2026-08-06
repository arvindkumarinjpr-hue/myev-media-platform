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
}
