import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Bounded `limit`, no cursor/offset — the identical, already-established
// convention ListBackgroundJobsDto uses (Module 1F Milestone 4): "No
// cursor/offset pagination precedent exists anywhere else in this API...
// a single bounded limit is the minimal deviation." Reused verbatim
// rather than inventing a new shape (Revision 3 §11).
export class ListSchedulesDto {
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  enabled?: boolean;

  @IsOptional()
  @IsString()
  jobType?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_LIMIT)
  limit: number = DEFAULT_LIMIT;
}
