"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cx } from "../../lib/cx";
import { workspacesApi } from "../../lib/api/workspaces";
import { friendlyMessage } from "../../lib/errors";
import type { WorkspaceSummary } from "../../lib/types";
import { CheckIcon, ChevronDownIcon, SwitchIcon } from "../ui/icons";
import { Menu } from "./Menu";
import styles from "./WorkspaceSwitcher.module.css";

interface WorkspaceSwitcherProps {
  workspaceId: string;
  workspaceName: string;
  role?: string;
  /** "rail" — the compact selector near the top of the dark desktop rail
   * (opens downward). "footer" (default) — the wider trigger used at the
   * bottom of the mobile drawer (opens upward, room permitting). */
  variant?: "rail" | "footer";
}

export function WorkspaceSwitcher({ workspaceId, workspaceName, role, variant = "footer" }: WorkspaceSwitcherProps) {
  return (
    <Menu
      label="Switch workspace"
      align="start"
      side={variant === "rail" ? "down" : "up"}
      className={styles.menu}
      trigger={({ ref, ...props }) => (
        <button ref={ref} type="button" className={cx(styles.trigger, variant === "rail" && styles.railTrigger)} {...props}>
          <span className={styles.avatar} aria-hidden="true">
            {workspaceName.charAt(0).toUpperCase()}
          </span>
          <span className={styles.identity}>
            <span className={styles.name}>{workspaceName}</span>
            {role && <span className={styles.role}>{role}</span>}
          </span>
          <ChevronDownIcon className={styles.chevron} />
        </button>
      )}
    >
      <WorkspaceList currentId={workspaceId} />
    </Menu>
  );
}

function WorkspaceList({ currentId }: { currentId: string }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    workspacesApi
      .listMine()
      .then(setWorkspaces)
      .catch((err) => setError(friendlyMessage(err)));
  }, []);

  return (
    <>
      <p className="menu-label">Workspaces</p>
      {error && <p className={styles.status}>{error}</p>}
      {!error && workspaces === null && <p className={styles.status}>Loading…</p>}
      {workspaces?.map((workspace) => (
        <Link
          key={workspace.publicId}
          href={`/workspaces/${workspace.publicId}`}
          role="menuitem"
          className="menu-item"
          aria-current={workspace.publicId === currentId ? "true" : undefined}
        >
          <span className={styles.itemAvatar} aria-hidden="true">
            {workspace.name.charAt(0).toUpperCase()}
          </span>
          <span className={styles.itemName}>{workspace.name}</span>
          {workspace.publicId === currentId && <CheckIcon />}
        </Link>
      ))}
      <div className="menu-separator" role="separator" />
      <Link href="/workspaces" role="menuitem" className="menu-item">
        <SwitchIcon />
        View all workspaces
      </Link>
    </>
  );
}
