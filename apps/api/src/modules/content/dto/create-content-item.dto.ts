import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from "class-validator";
import { SUPPORTED_CONTENT_TYPES } from "../content-permission.resolver";

export class CreateContentItemDto {
  // Rejecting SHORT/REEL/NEWSLETTER/SOCIAL_POST here, at the DTO layer,
  // gives a clean 400 before authorization or body validation ever run —
  // see ContentPermissionResolver's model comment for why only these 2
  // are supported in Module 1E.
  @IsIn(SUPPORTED_CONTENT_TYPES)
  contentType!: (typeof SUPPORTED_CONTENT_TYPES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  // Opaque JSONB — ContentBodyValidator is the single source of truth for
  // shape/size/depth/binary-content rules, not this DTO.
  @IsObject()
  body!: Record<string, unknown>;
}
