import { IsNotEmpty, IsString, IsUrl } from "class-validator";

/**
 * Module 9 Phase 9.7 (Part F) — the manual WordPress connect request
 * body, matching WordPressCredentialPayload's own field shape exactly
 * (`@myev/shared`) — no invented fields. `applicationPassword` is
 * write-only: it is validated + encrypted + persisted, then NEVER
 * echoed back in any response.
 */
export class ConnectWordPressDto {
  @IsUrl({ require_tld: false, require_protocol: true }, { message: "siteUrl must be a full URL including protocol (http:// or https://)." })
  siteUrl!: string;

  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  applicationPassword!: string;

  @IsString()
  @IsNotEmpty()
  displayName!: string;
}

/** Credential rotation (Part F/AA) — same shape minus `displayName` (rotation never renames an already-connected account). */
export class RotateWordPressDto {
  @IsUrl({ require_tld: false, require_protocol: true }, { message: "siteUrl must be a full URL including protocol (http:// or https://)." })
  siteUrl!: string;

  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  applicationPassword!: string;
}
