import type { Metadata } from "next";
import { serverGet } from "../../lib/server-api";
import type { WorkspaceSummary } from "../../lib/types";
import { Logo } from "../../components/shell/Logo";
import { SignOutButton } from "../../components/SignOutButton";
import { WorkspaceGrid } from "../../components/workspace/WorkspaceGrid";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Workspaces",
};

export default async function WorkspacePickerPage() {
  const workspaces = await serverGet<WorkspaceSummary[]>("workspaces");

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <Logo size="sm" />
        <SignOutButton />
      </header>

      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.title}>Your workspaces</h1>
          <p className={styles.subtitle}>
            {workspaces.length > 0
              ? "Select a workspace to continue."
              : "Once you're added to a workspace it will appear here."}
          </p>
        </div>
        <WorkspaceGrid workspaces={workspaces} />
      </main>
    </div>
  );
}
