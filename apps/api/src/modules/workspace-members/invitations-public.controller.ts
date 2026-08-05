import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";
import type { AccessTokenPayload } from "../auth/access-token.payload";
import { InvitationsService } from "./invitations.service";

/**
 * Deliberately unauthenticated at the route level — GET is a public
 * preview (token itself is the credential), and POST /accept must work
 * for a brand-new invitee with no session at all. Where a session exists,
 * it's read best-effort (a missing/invalid Authorization header is not an
 * error here — it just means "no session," one of the two valid states
 * InvitationsService.accept() branches on).
 */
@Controller("api/v1/invitations")
export class InvitationsPublicController {
  constructor(
    private readonly invitationsService: InvitationsService,
    private readonly jwtService: JwtService,
  ) {}

  @Get(":token")
  async preview(@Param("token") token: string) {
    const preview = await this.invitationsService.previewByToken(token);
    return { data: preview };
  }

  @Post(":token/accept")
  @HttpCode(HttpStatus.OK)
  async accept(@Param("token") token: string, @Req() req: Request) {
    const sessionUserPublicId = this.tryResolveSessionUser(req);
    const result = await this.invitationsService.accept(token, sessionUserPublicId, { ipAddress: req.ip });
    return { data: result };
  }

  private tryResolveSessionUser(req: Request): string | null {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;
    try {
      const payload = this.jwtService.verify<AccessTokenPayload>(header.slice("Bearer ".length));
      return payload.sub;
    } catch {
      return null;
    }
  }
}
