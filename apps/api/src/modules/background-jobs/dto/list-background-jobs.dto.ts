import { IsIn, IsInt, IsOptional, IsString, Max, Min } from "class-validator";
import { Type } from "class-transformer";
import { BackgroundJobStatus } from "../../../../generated/prisma";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// No cursor/offset pagination precedent exists anywhere else in this API
// (every other list endpoint returns its full filtered result set) — but
// background_jobs is fundamentally unbounded/high-volume in a way content
// and media are not, so an unbounded query here is a real operational
// risk. A single bounded `limit` (no pagination token machinery) is the
// minimal deviation that addresses that risk without inventing a new
// envelope convention this codebase doesn't otherwise have.
export class ListBackgroundJobsDto {
  @IsOptional()
  @IsIn(Object.values(BackgroundJobStatus))
  status?: BackgroundJobStatus;

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
