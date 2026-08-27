import Link from "next/link";
import { Logo } from "./Logo";
import { SidebarNav } from "./SidebarNav";
import { SidebarFooter } from "./SidebarFooter";
import styles from "./Sidebar.module.css";

interface SidebarProps {
  workspaceId: string;
  workspaceName: string;
  role?: string;
  permissions: string[];
}

/** Persistent desktop navigation rail. Hidden below the shell breakpoint, where the Drawer takes over. */
export function Sidebar({ workspaceId, workspaceName, role, permissions }: SidebarProps) {
  return (
    <aside className={styles.sidebar}>
      <div className={styles.brand}>
        <Link href={`/workspaces/${workspaceId}`} aria-label="MYEV Media — Overview">
          <Logo />
        </Link>
      </div>
      <div className={styles.scroll}>
        <SidebarNav workspaceId={workspaceId} permissions={permissions} />
      </div>
      <SidebarFooter workspaceId={workspaceId} workspaceName={workspaceName} role={role} />
    </aside>
  );
}
