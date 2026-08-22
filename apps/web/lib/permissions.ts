// The permission strings themselves are the backend's own constants
// (apps/api/src/modules/rbac/permissions.constants.ts) — never redefined
// here, just referenced as the literal values the API already returns
// from GET /workspaces/:workspaceId/permissions/me. This module is
// convenience-only: the backend remains the sole enforcement authority on
// every mutation, no matter what the UI shows or hides.
export function hasPermission(permissions: string[], required: string): boolean {
  return permissions.includes(required);
}

export function hasAnyPermission(permissions: string[], required: string[]): boolean {
  return required.some((permission) => permissions.includes(permission));
}
