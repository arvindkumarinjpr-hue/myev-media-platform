import { SetMetadata } from "@nestjs/common";
import type { PermissionConstant } from "../../modules/rbac/permissions.constants";

export const REQUIRE_PERMISSION_KEY = "require_permission";

/**
 * Accepts one permission or several — several means ALL are required
 * (Module 1D: version-replacement needs MEDIA_UPLOAD *and* MEDIA_MANAGE
 * together, per MODULE 1D ENGINEERING PLAN §3). Always stored as an
 * array internally so PermissionGuard has one shape to check regardless
 * of how a call site invoked this.
 */
export const RequirePermission = (permission: PermissionConstant | PermissionConstant[]): MethodDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, Array.isArray(permission) ? permission : [permission]);
