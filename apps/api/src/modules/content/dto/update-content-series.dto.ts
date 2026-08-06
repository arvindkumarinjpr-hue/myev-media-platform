import { IsString, MaxLength, MinLength } from "class-validator";

// Rename only, deliberately — a series' project affinity is fixed at
// creation. Changing it after the fact would require re-validating
// compatibility for every content item already assigned to it, which the
// approved Module 1E scope never asked for; delete and recreate instead.
export class UpdateContentSeriesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;
}
