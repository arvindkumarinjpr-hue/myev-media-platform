import { IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

// Deliberately no `workspaceId` field, at all — Revision 3 §3's mandatory
// rule: workspaceId is derived only from the route/context, never
// accepted from the request body. Its absence here is structural, not a
// validation rule that could be bypassed.
export class CreateScheduleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  jobType!: string;

  @IsObject()
  payload!: object;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  cronExpression!: string;

  @IsOptional()
  @IsString()
  timezone?: string;
}
