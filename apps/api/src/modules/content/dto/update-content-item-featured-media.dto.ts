import { IsUUID, ValidateIf } from "class-validator";

// Same "required, nullable" shape as the project/series reassignment DTOs.
export class UpdateContentItemFeaturedMediaDto {
  @ValidateIf((dto: UpdateContentItemFeaturedMediaDto) => dto.mediaAssetId !== null)
  @IsUUID()
  mediaAssetId!: string | null;
}
