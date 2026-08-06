import { IsObject, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

// title/metadata only — body is versioned (POST .../versions), projectId
// has its own endpoint (series-compatibility recheck), series has its own
// endpoint (locking), featured media has its own endpoint (attach rules).
export class UpdateContentItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
