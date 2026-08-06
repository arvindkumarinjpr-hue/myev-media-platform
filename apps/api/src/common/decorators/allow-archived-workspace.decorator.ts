import { SetMetadata } from "@nestjs/common";

export const ALLOW_ARCHIVED_WORKSPACE_KEY = "allowArchivedWorkspace";

/**
 * Module 1C Engineering Plan §2.A: archiving blocks all further workspace
 * access EXCEPT the restore endpoint and read-only settings views needed to
 * decide whether to restore. Handlers that must remain reachable on an
 * ARCHIVED workspace (view, restore, delete — delete requires the
 * workspace already be archived) opt in with this decorator; every other
 * workspace-scoped handler rejects archived workspaces by default.
 */
export const AllowArchivedWorkspace = () => SetMetadata(ALLOW_ARCHIVED_WORKSPACE_KEY, true);
