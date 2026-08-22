import styles from "./StatusBadge.module.css";
import type { KnowledgePackStatus } from "../../lib/types";

const LABELS: Record<KnowledgePackStatus, string> = {
  DRAFT: "Draft",
  VALIDATING: "Validating",
  ACTIVE: "Active",
  ARCHIVED: "Archived",
};

export function StatusBadge({ status }: { status: KnowledgePackStatus }) {
  return <span className={`${styles.badge} ${styles[status.toLowerCase()]}`}>{LABELS[status]}</span>;
}
