import { IsEmail, IsIn } from "class-validator";
import { ASSIGNABLE_ROLE_NAMES } from "../assignable-roles";

export class InviteMemberDto {
  @IsEmail()
  email!: string;

  @IsIn(ASSIGNABLE_ROLE_NAMES)
  roleName!: (typeof ASSIGNABLE_ROLE_NAMES)[number];
}
