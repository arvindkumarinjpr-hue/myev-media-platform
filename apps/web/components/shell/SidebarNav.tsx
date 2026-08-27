"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "../../lib/cx";
import { hasPermission } from "../../lib/permissions";
import { NAV_SECTIONS, hrefFor, isActive } from "./navigation";
import styles from "./SidebarNav.module.css";

interface SidebarNavProps {
  workspaceId: string;
  permissions: string[];
  /** Called after a nav link is activated — lets the mobile drawer close itself. */
  onNavigate?: () => void;
  /** Landmark label — distinct per instance so the persistent rail and the drawer copy don't collide. */
  label?: string;
}

export function SidebarNav({ workspaceId, permissions, onNavigate, label = "Primary" }: SidebarNavProps) {
  const pathname = usePathname() ?? "";

  return (
    <nav className={styles.nav} aria-label={label}>
      {NAV_SECTIONS.map((section, i) => {
        const items = section.items.filter((item) => !item.permission || hasPermission(permissions, item.permission));
        if (items.length === 0) return null;
        return (
          <div key={section.title ?? `section-${i}`} className={styles.section}>
            {section.title && <p className={styles.sectionTitle}>{section.title}</p>}
            <ul className={styles.list}>
              {items.map((item) => {
                const active = isActive(pathname, workspaceId, item.segment);
                const Icon = item.icon;
                return (
                  <li key={item.segment || "overview"}>
                    <Link
                      href={hrefFor(workspaceId, item.segment)}
                      className={cx(styles.link, active && styles.active)}
                      aria-current={active ? "page" : undefined}
                      onClick={onNavigate}
                    >
                      <Icon className={styles.icon} />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
