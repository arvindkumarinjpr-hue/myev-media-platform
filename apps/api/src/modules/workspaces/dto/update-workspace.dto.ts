import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";
import { DATE_FORMATS, SLUG_PATTERN } from "./create-workspace.dto";

export class UpdateWorkspaceDto {
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

  // Deliberately no featureFlags field — platform-controlled, not writable
  // through this endpoint (Module 1C Engineering Plan §2.A). class-validator's
  // whitelist:true (main.ts) strips any unknown field a client sends anyway.
}
