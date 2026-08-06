import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class CreateContentSeriesDto {
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  // Workspace-level (unset) or a specific project's public id — the
  // service layer resolves and verifies this belongs to the caller's
  // workspace, same rule as every other project-scoping field.
  @IsOptional()
  @IsUUID()
  projectId?: string;
}
