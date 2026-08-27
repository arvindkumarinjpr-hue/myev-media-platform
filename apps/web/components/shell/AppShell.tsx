"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { Drawer } from "../ui/Drawer";
import { Logo } from "./Logo";
import { Sidebar } from "./Sidebar";
import { SidebarNav } from "./SidebarNav";
import { SidebarFooter } from "./SidebarFooter";
import { Topbar } from "./Topbar";
import styles from "./AppShell.module.css";

interface AppShellProps {
  workspaceId: string;
  workspaceName: string;
  role?: string;
  permissions: string[];
  children: ReactNode;
}

export function AppShell({ workspaceId, workspaceName, role, permissions, children }: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const pathname = usePathname();

  // Close the mobile drawer on route change (a nav link was followed).
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  return (
    <div className={styles.shell}>
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>

      <Sidebar workspaceId={workspaceId} workspaceName={workspaceName} role={role} permissions={permissions} />

      <Drawer open={navOpen} onClose={() => setNavOpen(false)} title={<Logo size="sm" />}>
        <div className={styles.drawerBody}>
          <SidebarNav
            workspaceId={workspaceId}
            permissions={permissions}
            onNavigate={() => setNavOpen(false)}
            label="Primary (menu)"
          />
          <SidebarFooter workspaceId={workspaceId} workspaceName={workspaceName} role={role} />
        </div>
      </Drawer>

      <div className={styles.main}>
        <Topbar workspaceId={workspaceId} workspaceName={workspaceName} onOpenNav={() => setNavOpen(true)} />
        <main id="main-content" className={styles.content} tabIndex={-1}>
          <div className={styles.container}>{children}</div>
        </main>
      </div>
    </div>
  );
}
