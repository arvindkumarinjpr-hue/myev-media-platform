import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";
import { VideoTargetPlatform } from "../../../../generated/prisma";

/**
 * Module 7 Phase 7.1 — POST /video input. `topic` + the EXACT Knowledge
 * Pack version + `targetPlatform` are the required inputs:
 *  - FR-VID-001: "Target platform required. Missing platform → 400."
 *  - Requires an ACTIVE Knowledge Pack (business rule, FR-VID-001).
 *
 * `projectId` / `seriesId` are optional and only honoured when the
 * existing Module 1E model already supports them (it does).
 * `durationSecondsTarget` is an optional hint recorded on video_scripts;
 * the brief agent (Phase 7.2) can also derive it.
 */
export class CreateVideoDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  topic!: string;

  @IsUUID()
  knowledgePackVersionId!: string;

  @IsEnum(VideoTargetPlatform)
  targetPlatform!: VideoTargetPlatform;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(7200)
  durationSecondsTarget?: number;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  seriesId?: string;
}
