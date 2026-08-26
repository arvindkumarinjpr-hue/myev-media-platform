import styles from "./ResearchStatusBadge.module.css";
import type { ResearchStatus } from "../../lib/types";

const LABELS: Record<ResearchStatus, string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  TIMED_OUT: "Timed out",
};

export function ResearchStatusBadge({ status }: { status: ResearchStatus }) {
  return <span className={`${styles.badge} ${styles[status.toLowerCase()]}`}>{LABELS[status]}</span>;
}
