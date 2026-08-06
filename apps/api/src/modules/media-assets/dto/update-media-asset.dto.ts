import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class UpdateMediaAssetDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  normalizedFilename?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  // Reassignment within the same workspace only — service layer verifies
  // the target project belongs to the caller's resolved workspace.
  @IsOptional()
  @IsUUID()
  projectId?: string;
}
