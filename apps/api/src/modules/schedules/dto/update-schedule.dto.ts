import { IsInt, IsObject, IsOptional, IsString, Min, MinLength } from "class-validator";

// version is required, not optional — Revision 3 §4: every Update is
// optimistically locked. cronExpression/timezone/payload are each
// optional (a caller may update just one), but changing either
// cronExpression or timezone triggers a fresh nextRunAt computation
// (Revision 3 §5) — never a partial/stale recompute.
export class UpdateScheduleDto {
  @IsInt()
  @Min(1)
  version!: number;

  @IsOptional()
  @IsObject()
  payload?: object;

  @IsOptional()
  @IsString()
  @MinLength(1)
  cronExpression?: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}
