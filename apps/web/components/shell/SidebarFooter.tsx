import { AccountMenu } from "./AccountMenu";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import styles from "./SidebarFooter.module.css";

interface SidebarFooterProps {
  workspaceId: string;
  workspaceName: string;
  role?: string;
}

export function SidebarFooter({ workspaceId, workspaceName, role }: SidebarFooterProps) {
  return (
    <div className={styles.footer}>
      <WorkspaceSwitcher workspaceId={workspaceId} workspaceName={workspaceName} role={role} />
      <div className={styles.account}>
        <AccountMenu role={role} />
      </div>
    </div>
  );
}
