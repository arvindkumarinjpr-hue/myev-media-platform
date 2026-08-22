import Link from "next/link";
import { serverGet } from "../../lib/server-api";
import type { WorkspaceSummary } from "../../lib/types";
import { EmptyState } from "../../components/ui/Feedback";
import styles from "./page.module.css";

export default async function WorkspacePickerPage() {
  const workspaces = await serverGet<WorkspaceSummary[]>("workspaces");

  return (
    <main className={styles.container}>
      <h1>Your workspaces</h1>
      {workspaces.length === 0 ? (
        <EmptyState title="No workspaces yet" description="You're not a member of any workspace." />
      ) : (
        <ul className={styles.list}>
          {workspaces.map((workspace) => (
            <li key={workspace.publicId}>
              <Link href={`/workspaces/${workspace.publicId}/knowledge-packs`} className={styles.workspaceLink}>
                {workspace.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
