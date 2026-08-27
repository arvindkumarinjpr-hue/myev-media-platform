import type { KnowledgePackStatus } from "../../lib/types";
import { Badge, type BadgeTone } from "./Badge";

const CONFIG: Record<KnowledgePackStatus, { label: string; tone: BadgeTone }> = {
  DRAFT: { label: "Draft", tone: "neutral" },
  VALIDATING: { label: "Validating", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  ARCHIVED: { label: "Archived", tone: "info" },
};

export function StatusBadge({ status }: { status: KnowledgePackStatus }) {
  const { label, tone } = CONFIG[status];
  return <Badge tone={tone}>{label}</Badge>;
}
