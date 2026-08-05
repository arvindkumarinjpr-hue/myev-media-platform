import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { PasswordHashService } from "../../common/crypto/password-hash.service";

@Module({
  providers: [UsersService, PasswordHashService],
  exports: [UsersService, PasswordHashService],
})
export class UsersModule {}
