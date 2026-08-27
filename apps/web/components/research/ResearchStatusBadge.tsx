import type { ResearchStatus } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { RESEARCH_STATUS } from "./researchLabels";

export function ResearchStatusBadge({ status }: { status: ResearchStatus }) {
  const { label, tone, dot } = RESEARCH_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}
