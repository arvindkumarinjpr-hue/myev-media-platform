import type { BlogDeterministicStageStatus, BlogGenerationStageStatus, ContentItemStatus } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { CONTENT_ITEM_STATUS, DETERMINISTIC_STAGE_STATUS, GENERATION_STAGE_STATUS } from "./blogLabels";

export function GenerationStageBadge({ status, pending }: { status: BlogGenerationStageStatus; pending?: boolean }) {
  if (pending && status === "READY") {
    return (
      <Badge tone="info" dot>
        Finalizing
      </Badge>
    );
  }
  const { label, tone, dot } = GENERATION_STAGE_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}

export function DeterministicStageBadge({ status }: { status: BlogDeterministicStageStatus }) {
  const { label, tone } = DETERMINISTIC_STAGE_STATUS[status];
  return <Badge tone={tone}>{label}</Badge>;
}

export function ContentItemStatusBadge({ status }: { status: ContentItemStatus }) {
  const { label, tone, dot } = CONTENT_ITEM_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}
