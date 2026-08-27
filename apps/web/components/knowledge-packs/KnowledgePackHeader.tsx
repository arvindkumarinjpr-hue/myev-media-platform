import type { ReactNode } from "react";
import Link from "next/link";
import type { KnowledgePackStatus } from "../../lib/types";
import { StatusBadge } from "../ui/StatusBadge";
import { ChevronRightIcon } from "../ui/icons";
import styles from "./KnowledgePackHeader.module.css";

interface KnowledgePackHeaderProps {
  workspaceId: string;
  name: string;
  status: KnowledgePackStatus;
  versionNumber: number;
  /** Lifecycle actions — validate / create-version etc. (destructive ones live in the Danger Zone, not here). */
  actions?: ReactNode;
}

export function KnowledgePackHeader({ workspaceId, name, status, versionNumber, actions }: KnowledgePackHeaderProps) {
  return (
    <header className={styles.header}>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href={`/workspaces/${workspaceId}/knowledge-packs`}>Knowledge Packs</Link>
        <ChevronRightIcon className={styles.sep} />
        <span aria-current="page">{name}</span>
      </nav>

      <div className={styles.row}>
        <div className={styles.titleBlock}>
          <h1 className={styles.title}>{name}</h1>
          <div className={styles.meta}>
            <StatusBadge status={status} />
            <span className={styles.version}>Version {versionNumber}</span>
          </div>
        </div>
        {actions && <div className={styles.actions}>{actions}</div>}
      </div>
    </header>
  );
}
