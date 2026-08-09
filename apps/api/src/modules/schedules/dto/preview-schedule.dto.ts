import { IsInt, IsOptional, Max, Min } from "class-validator";
import { Type } from "class-transformer";

export const PREVIEW_DEFAULT_COUNT = 5;
export const PREVIEW_MIN_COUNT = 1;
export const PREVIEW_MAX_COUNT = 20;

export class PreviewScheduleDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(PREVIEW_MIN_COUNT)
  @Max(PREVIEW_MAX_COUNT)
  count: number = PREVIEW_DEFAULT_COUNT;
}
