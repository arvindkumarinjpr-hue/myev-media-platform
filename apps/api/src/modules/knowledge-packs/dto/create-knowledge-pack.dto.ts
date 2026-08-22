import { IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";

export class CreateKnowledgePackDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  // Public ID of a Project in this workspace — resolved to the internal
  // FK at the service layer (ADR-013: never accept an internal id from
  // the API surface), same pattern as CreateContentItemDto.projectId.
  // Omitted entirely => workspace-wide pack (Database Design §5.3).
  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsObject()
  industryProfile?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  publishingStrategy?: Record<string, unknown>;
}
