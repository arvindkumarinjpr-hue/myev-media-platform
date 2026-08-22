"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { logout } from "../lib/api/auth";
import styles from "./AppNav.module.css";

export function AppNav({ workspaceId, workspaceName }: { workspaceId: string; workspaceName: string }) {
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.push("/login");
    router.refresh();
  }

  return (
    <nav className={styles.nav} aria-label="Primary">
      <div className={styles.brand}>{workspaceName}</div>
      <ul className={styles.links}>
        <li>
          <Link href={`/workspaces/${workspaceId}/knowledge-packs`}>Knowledge Packs</Link>
        </li>
        <li>
          <Link href={`/workspaces/${workspaceId}/projects`}>Projects</Link>
        </li>
      </ul>
      <div className={styles.actions}>
        <Link href="/workspaces">Switch workspace</Link>
        <button type="button" onClick={handleLogout} className={styles.logoutButton}>
          Sign out
        </button>
      </div>
    </nav>
  );
}
