import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import type { AppConfig } from "../../config/configuration";
import { PasswordPolicyService } from "../../common/crypto/password-policy.service";
import { TokenService } from "../../common/crypto/token.service";
import { AdaptiveProtectionService } from "../../common/rate-limit/adaptive-protection.service";
import { SessionGuard } from "../../common/guards/session.guard";
import { EmailModule } from "../email/email.module";
import { UsersModule } from "../users/users.module";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionsService } from "./sessions.service";

@Module({
  imports: [
    UsersModule,
    EmailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>) => {
        const auth = config.get("auth", { infer: true });
        return { secret: auth.jwtSecret, signOptions: { expiresIn: auth.accessTokenTtlSeconds } };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SessionsService, PasswordPolicyService, TokenService, AdaptiveProtectionService, SessionGuard],
  exports: [SessionGuard, SessionsService],
})
export class AuthModule {}
