import { IsUUID, ValidateIf } from "class-validator";

// Same "required, nullable" shape as UpdateContentItemProjectDto — this
// endpoint covers assign/reassign/unassign, so omission is never valid.
export class UpdateContentItemSeriesDto {
  @ValidateIf((dto: UpdateContentItemSeriesDto) => dto.seriesId !== null)
  @IsUUID()
  seriesId!: string | null;
}
