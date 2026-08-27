"use client";

import { usePathname } from "next/navigation";
import { cx } from "../../lib/cx";
import { MenuIcon } from "../ui/icons";
import { Logo } from "./Logo";
import { NAV_SECTIONS, isActive } from "./navigation";
import styles from "./Topbar.module.css";

interface TopbarProps {
  workspaceId: string;
  workspaceName: string;
  onOpenNav: () => void;
}

function sectionLabel(pathname: string, workspaceId: string): string | null {
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      if (item.segment && isActive(pathname, workspaceId, item.segment)) return item.label;
    }
  }
  return null;
}

export function Topbar({ workspaceId, workspaceName, onOpenNav }: TopbarProps) {
  const pathname = usePathname() ?? "";
  const section = sectionLabel(pathname, workspaceId);

  return (
    <header className={styles.topbar}>
      <button type="button" className={styles.menuButton} onClick={onOpenNav} aria-label="Open navigation menu">
        <MenuIcon />
      </button>

      <span className={styles.mobileLogo}>
        <Logo size="sm" />
      </span>

      <nav className={styles.context} aria-label="Breadcrumb">
        <span className={styles.workspace}>{workspaceName}</span>
        {section && (
          <>
            <span className={styles.divider} aria-hidden="true">
              /
            </span>
            <span className={cx(styles.crumb, styles.current)} aria-current="page">
              {section}
            </span>
          </>
        )}
      </nav>
    </header>
  );
}
