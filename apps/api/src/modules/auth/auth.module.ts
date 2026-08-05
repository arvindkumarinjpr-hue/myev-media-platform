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

const JWT_MODULE = JwtModule.registerAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<AppConfig, true>) => {
    const auth = config.get("auth", { infer: true });
    return { secret: auth.jwtSecret, signOptions: { expiresIn: auth.accessTokenTtlSeconds } };
  },
});

@Module({
  imports: [UsersModule, EmailModule, JWT_MODULE],
  controllers: [AuthController],
  providers: [AuthService, SessionsService, PasswordPolicyService, TokenService, AdaptiveProtectionService, SessionGuard],
  // JwtModule re-exported: Module 1C's public invitation-accept endpoint
  // needs JwtService directly (to best-effort decode an optional session,
  // since accept() must also work with no session at all) — not just
  // indirectly through SessionGuard. AdaptiveProtectionService re-exported:
  // Module 1C's activation-resend rate limiting reuses it directly.
  // TokenService re-exported: Module 1C's invitation/activation tokens
  // reuse the same opaque-token generation/hashing as refresh/reset tokens.
  exports: [SessionGuard, SessionsService, JWT_MODULE, AdaptiveProtectionService, TokenService],
})
export class AuthModule {}
