import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request, Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { AdaptiveProtectionService } from "../../common/rate-limit/adaptive-protection.service";
import { SessionGuard, type AuthenticatedRequest } from "../../common/guards/session.guard";
import type { AppConfig } from "../../config/configuration";
import { AuthService } from "./auth.service";
import { ChangePasswordDto } from "./dto/change-password.dto";
import { ForgotPasswordDto } from "./dto/forgot-password.dto";
import { LoginDto } from "./dto/login.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { SessionsService } from "./sessions.service";

const REFRESH_COOKIE_NAME = "refresh_token";
const LOGIN_RATE_LIMIT = { limit: 10, windowSeconds: 60 };
const FORGOT_PASSWORD_RATE_LIMIT = { limit: 5, windowSeconds: 60 };
const GENERIC_FORGOT_PASSWORD_MESSAGE = "If an account exists for that email, a reset link has been sent.";

@Controller("api/v1/auth")
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly sessionsService: SessionsService,
    private readonly protection: AdaptiveProtectionService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.enforceRateLimit(`login:${req.ip}`, LOGIN_RATE_LIMIT);

    const result = await this.authService.login(dto.email, dto.password, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    this.setRefreshCookie(res, result.refreshTokenPlaintext);
    return { data: { access_token: result.accessToken, user: result.user } };
  }

  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    if (!refreshToken) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "No refresh token presented." });
    }

    const result = await this.authService.refresh(refreshToken, {
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
    });

    this.setRefreshCookie(res, result.refreshTokenPlaintext);
    return { data: { access_token: result.accessToken } };
  }

  @Post("logout")
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.OK)
  async logout(@CurrentUser() user: AuthenticatedRequest["user"], @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(user.sessionId);
    res.clearCookie(REFRESH_COOKIE_NAME);
    return { data: { success: true } };
  }

  @Post("forgot-password")
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.enforceRateLimit(`forgot-password:${req.ip}`, FORGOT_PASSWORD_RATE_LIMIT);
    await this.authService.forgotPassword(dto.email, { ipAddress: req.ip, userAgent: req.headers["user-agent"] });
    // Enumeration-safe: identical response whether or not the account exists.
    return { data: { message: GENERIC_FORGOT_PASSWORD_MESSAGE } };
  }

  @Post("reset-password")
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto.token, dto.newPassword);
    return { data: { success: true } };
  }

  @Post("change-password")
  @UseGuards(SessionGuard)
  @HttpCode(HttpStatus.OK)
  async changePassword(@CurrentUser() user: AuthenticatedRequest["user"], @Body() dto: ChangePasswordDto) {
    const session = await this.sessionsService.findByPublicId(user.sessionId);
    await this.authService.changePassword(session!.userId, session!.id, dto.currentPassword, dto.newPassword);
    return { data: { success: true } };
  }

  @Get("me")
  @UseGuards(SessionGuard)
  async me(@CurrentUser() user: AuthenticatedRequest["user"]) {
    return { data: { userPublicId: user.sub, sessionId: user.sessionId } };
  }

  private async enforceRateLimit(key: string, options: { limit: number; windowSeconds: number }): Promise<void> {
    const result = await this.protection.checkRateLimit(key, options.limit, options.windowSeconds);
    if (!result.allowed) {
      throw new HttpException(
        { code: "RATE_LIMITED", message: "Too many requests. Please try again later.", retryAfterSeconds: result.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private setRefreshCookie(res: Response, refreshTokenPlaintext: string): void {
    const auth = this.config.get("auth", { infer: true });
    const isProduction = this.config.get("env", { infer: true }) === "production";
    res.cookie(REFRESH_COOKIE_NAME, refreshTokenPlaintext, {
      httpOnly: true,
      secure: isProduction,
      sameSite: "strict",
      maxAge: auth.refreshTokenTtlSeconds * 1000,
      path: "/api/v1/auth",
    });
  }
}
