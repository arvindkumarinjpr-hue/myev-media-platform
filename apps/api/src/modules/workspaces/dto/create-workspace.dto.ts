import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

// Lowercase, hyphen-separated, matches the pattern used for every slug in
// this platform — display/routing convenience only, never a lookup key
// (Module 1C Engineering Plan §1).
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_FORMATS = ["YYYY-MM-DD", "MM/DD/YYYY", "DD/MM/YYYY", "DD-MM-YYYY"];

export class CreateWorkspaceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(63)
  @Matches(SLUG_PATTERN, { message: "slug must be lowercase alphanumeric, hyphen-separated." })
  slug!: string;

  @IsOptional()
  @IsString()
  timezone?: string;

  @IsOptional()
  @IsString()
  locale?: string;

  @IsOptional()
  @IsString()
  currency?: string;

  @IsOptional()
  @IsIn(DATE_FORMATS)
  dateFormat?: string;
}

export { SLUG_PATTERN, DATE_FORMATS };
