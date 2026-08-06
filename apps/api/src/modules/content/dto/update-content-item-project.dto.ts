import { IsUUID, ValidateIf } from "class-validator";

// projectId is required in the payload (either a UUID or explicit null)
// rather than optional — this endpoint's whole purpose is reassignment
// including "unassign", so an omitted field would be ambiguous between
// "don't change it" and a client mistake. No @IsOptional(): sending
// nothing at all correctly fails validation.
export class UpdateContentItemProjectDto {
  @ValidateIf((dto: UpdateContentItemProjectDto) => dto.projectId !== null)
  @IsUUID()
  projectId!: string | null;
}
