import type { ResearchStatus } from "../../lib/types";
import { Badge, type BadgeTone } from "../ui/Badge";

const CONFIG: Record<ResearchStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  QUEUED: { label: "Queued", tone: "neutral", dot: true },
  RUNNING: { label: "Running", tone: "warning", dot: true },
  COMPLETED: { label: "Completed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  TIMED_OUT: { label: "Timed out", tone: "danger" },
};

export function ResearchStatusBadge({ status }: { status: ResearchStatus }) {
  const { label, tone, dot } = CONFIG[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}
