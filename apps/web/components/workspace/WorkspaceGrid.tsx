import Link from "next/link";
import type { WorkspaceSummary } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { EmptyState } from "../ui/Feedback";
import { ChevronRightIcon, OverviewIcon } from "../ui/icons";
import styles from "./WorkspaceGrid.module.css";

/** Presentational — the /workspaces server page fetches and passes the list in. */
export function WorkspaceGrid({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  if (workspaces.length === 0) {
    return (
      <EmptyState
        icon={<OverviewIcon />}
        title="No workspaces yet"
        description="You're not a member of any workspace. Ask a workspace owner to invite you."
      />
    );
  }

  return (
    <ul className={styles.grid}>
      {workspaces.map((workspace) => {
        const archived = workspace.status?.toUpperCase() === "ARCHIVED";
        return (
          <li key={workspace.publicId}>
            <Link href={`/workspaces/${workspace.publicId}`} className={styles.card}>
              <span className={styles.avatar} aria-hidden="true">
                {workspace.name.charAt(0).toUpperCase()}
              </span>
              <span className={styles.body}>
                <span className={styles.name}>{workspace.name}</span>
                <span className={styles.meta}>
                  {archived ? <Badge tone="warning">Archived</Badge> : <span className={styles.slug}>{workspace.slug}</span>}
                </span>
              </span>
              <ChevronRightIcon className={styles.chevron} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
