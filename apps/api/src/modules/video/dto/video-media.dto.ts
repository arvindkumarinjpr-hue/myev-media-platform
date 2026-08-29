import { IsIn, IsInt, IsOptional, IsString, Max, Min, MinLength } from "class-validator";

/** POST /assets/scenes/:sceneId/attach */
export class VideoAttachSceneAssetDto {
  @IsString()
  @MinLength(1)
  mediaAssetPublicId!: string;
}

/** POST /voice/generate */
export class VideoGenerateVoiceDto {
  @IsString()
  @MinLength(1)
  voiceProfileId!: string;

  @IsOptional()
  @IsIn(["neutral", "newscast", "cheerful", "calm"])
  style?: string;
}

/** POST /thumbnail-concepts/select */
export class VideoSelectThumbnailConceptDto {
  @IsInt()
  @Min(0)
  @Max(9)
  conceptIndex!: number;
}
