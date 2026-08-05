import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService, TokenExpiredError } from "@nestjs/jwt";
import type { Request } from "express";
import type { AccessTokenPayload } from "../../modules/auth/access-token.payload";

export interface AuthenticatedRequest extends Request {
  user: AccessTokenPayload;
}

/**
 * Authenticated-session check — distinct from permission-based
 * authorization (PermissionGuard). Every Module 1B.1 endpoint that
 * requires a caller to be logged in uses this guard; none of them require
 * a specific permission, since nothing in 1B.1 is workspace-scoped yet
 * (Module 1B.1 Engineering Plan §8).
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Missing or malformed Authorization header." });
    }
    const token = header.slice("Bearer ".length);
    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(token);
      (request as AuthenticatedRequest).user = payload;
      return true;
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        throw new UnauthorizedException({ code: "AUTH_TOKEN_EXPIRED", message: "Access token has expired." });
      }
      throw new UnauthorizedException({ code: "AUTH_TOKEN_INVALID", message: "Access token is invalid." });
    }
  }
}
