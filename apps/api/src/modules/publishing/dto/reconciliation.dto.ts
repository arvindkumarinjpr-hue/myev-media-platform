import { IsOptional, IsString, IsUrl, MinLength } from "class-validator";

export class MarkExternallyPublishedDto {
  @IsString()
  @MinLength(1)
  externalContentId!: string;

  @IsOptional()
  @IsUrl({ require_protocol: true })
  externalUrl?: string;

  @IsString()
  @MinLength(1, { message: "A note explaining how the operator verified this externally is required." })
  note!: string;
}

export class ConfirmNotPublishedDto {
  @IsString()
  @MinLength(1, { message: "A note explaining how the operator verified this was NOT externally published is required." })
  note!: string;
}
