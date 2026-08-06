import { IsObject } from "class-validator";

export class CreateContentVersionDto {
  @IsObject()
  body!: Record<string, unknown>;
}
