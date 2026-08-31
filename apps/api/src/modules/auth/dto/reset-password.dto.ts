import { IsString, MaxLength, MinLength } from "class-validator";

const POLICY_MESSAGE = "Password must be between 8 and 64 characters.";

export class ResetPasswordDto {
  @IsString()
  token!: string;

  @IsString()
  @MinLength(8, { message: POLICY_MESSAGE })
  @MaxLength(64, { message: POLICY_MESSAGE })
  newPassword!: string;
}
