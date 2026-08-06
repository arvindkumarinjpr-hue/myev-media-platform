import { IsIn, IsInt, IsOptional, IsPositive, IsString, IsUUID, Matches, MaxLength, MinLength } from "class-validator";

const ASSET_TYPES = ["IMAGE", "AUDIO", "VIDEO", "DOCUMENT"] as const;
const CHECKSUM_PATTERN = /^[0-9a-fA-F]{64}$/;

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

  @IsOptional()
  @IsString()
  @Matches(CHECKSUM_PATTERN, { message: "expectedChecksumSha256 must be exactly 64 hexadecimal characters." })
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

  @IsOptional()
  @IsString()
  @Matches(CHECKSUM_PATTERN, { message: "expectedChecksumSha256 must be exactly 64 hexadecimal characters." })
  expectedChecksumSha256?: string;
}

export { ASSET_TYPES, CHECKSUM_PATTERN };
