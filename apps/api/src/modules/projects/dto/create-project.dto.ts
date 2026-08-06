import { IsString, Matches, MaxLength, MinLength } from "class-validator";

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(63)
  @Matches(SLUG_PATTERN, { message: "slug must be lowercase alphanumeric, hyphen-separated." })
  slug!: string;
}

export { SLUG_PATTERN };
