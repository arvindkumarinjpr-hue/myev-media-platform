import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsBoolean, IsString, MinLength, ValidateNested } from "class-validator";

export class MetaPageSelectionDto {
  @IsString()
  @MinLength(1)
  pageId!: string;

  @IsBoolean()
  connectFacebook!: boolean;

  @IsBoolean()
  connectInstagram!: boolean;
}

/** Module 9 Phase 9.7 (Part H) — the operator's account-selection choices after reviewing the discovered Facebook Pages / linked Instagram accounts. */
export class MetaFinalizeSelectionDto {
  @IsString()
  @MinLength(1)
  discoveryToken!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => MetaPageSelectionDto)
  selections!: MetaPageSelectionDto[];
}
