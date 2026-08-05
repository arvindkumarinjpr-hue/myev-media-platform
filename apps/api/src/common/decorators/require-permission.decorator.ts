import { SetMetadata } from "@nestjs/common";
import type { PermissionConstant } from "../../modules/rbac/permissions.constants";

export const REQUIRE_PERMISSION_KEY = "require_permission";

/**
 * No endpoint in Module 1B.1's own inventory uses this — see
 * PermissionGuard for why. Built now as reusable infrastructure for 1C.
 */
export const RequirePermission = (permission: PermissionConstant): MethodDecorator =>
  SetMetadata(REQUIRE_PERMISSION_KEY, permission);
