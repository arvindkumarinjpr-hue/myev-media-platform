import Link from "next/link";
import { Logo } from "./Logo";
import { SidebarNav } from "./SidebarNav";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { AccountMenu } from "./AccountMenu";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  workspaceId: string;
  workspaceName: string;
  role?: string;
  permissions: string[];
}

/**
 * Persistent desktop navigation rail — a permanently dark surface (see the
 * --color-sidebar-* token remap in Sidebar.module.css). Hidden below the
 * shell breakpoint, where the Drawer takes over with the same SidebarNav.
 */
export function Sidebar({ workspaceId, workspaceName, role, permissions }: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <Link href={`/workspaces/${workspaceId}`} aria-label="MYEV Media — Overview" className={styles.brandChip}>
          <Logo />
        </Link>
      </div>

      <div className={styles.switcher}>
        <WorkspaceSwitcher workspaceId={workspaceId} workspaceName={workspaceName} role={role} variant="rail" />
      </div>

      <div className={styles.scroll}>
        <SidebarNav workspaceId={workspaceId} permissions={permissions} />
      </div>

      <div className={styles.footer}>
        <AccountMenu role={role} />
      </div>
    </aside>
  );
}
