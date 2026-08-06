import { IsIn, IsInt, IsOptional, IsPositive, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

const ASSET_TYPES = ["IMAGE", "AUDIO", "VIDEO", "DOCUMENT"] as const;

export class CreateUploadIntentDto {
  @IsIn(ASSET_TYPES)
  assetType!: (typeof ASSET_TYPES)[number];

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  originalFilename!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(127)
  declaredMimeType!: string;

  @IsInt()
  @IsPositive()
  declaredSizeBytes!: number;

  // Format (exactly 64 hex, case normalized) is validated and normalized
  // in MediaAssetsService, not here — a DTO-level @Matches would reject
  // with class-validator's generic shape, short-circuiting before the
  // service's own MEDIA_ASSET_INVALID_CHECKSUM_FORMAT code ever runs.
  @IsOptional()
  @IsString()
  @MaxLength(256)
  expectedChecksumSha256?: string;
}

/** Version-replacement intent — assetType/projectId are always inherited
 * from the current version being replaced, never client-supplied. See
 * MODULE 1D ENGINEERING PLAN §3. */
export class CreateVersionUploadIntentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  originalFilename!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(127)
  declaredMimeType!: string;

  @IsInt()
  @IsPositive()
  declaredSizeBytes!: number;

  // Format (exactly 64 hex, case normalized) is validated and normalized
  // in MediaAssetsService, not here — a DTO-level @Matches would reject
  // with class-validator's generic shape, short-circuiting before the
  // service's own MEDIA_ASSET_INVALID_CHECKSUM_FORMAT code ever runs.
  @IsOptional()
  @IsString()
  @MaxLength(256)
  expectedChecksumSha256?: string;
}

export { ASSET_TYPES };
