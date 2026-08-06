import { IsIn, IsOptional } from "class-validator";
import { ASSIGNABLE_ROLE_NAMES } from "../assignable-roles";

export class UpdateMemberDto {
  @IsOptional()
  @IsIn(ASSIGNABLE_ROLE_NAMES)
  roleName?: (typeof ASSIGNABLE_ROLE_NAMES)[number];

  @IsOptional()
  @IsIn(["ACTIVE", "SUSPENDED"])
  status?: "ACTIVE" | "SUSPENDED";
}
