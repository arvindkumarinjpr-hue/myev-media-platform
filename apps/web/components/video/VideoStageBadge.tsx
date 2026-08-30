import type {
  ContentItemStatus,
  VideoAdvisoryStageStatus,
  VideoDeterministicStageStatus,
  VideoGenerationStageStatus,
  VideoMediaStageStatus,
} from "../../lib/types";
import { Badge } from "../ui/Badge";
import {
  ADVISORY_STAGE_STATUS,
  CONTENT_ITEM_STATUS,
  DETERMINISTIC_STAGE_STATUS,
  GENERATION_STAGE_STATUS,
  MEDIA_STAGE_STATUS,
} from "./videoLabels";

export function GenerationStageBadge({ status }: { status: VideoGenerationStageStatus }) {
  const { label, tone, dot } = GENERATION_STAGE_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}

export function AdvisoryStageBadge({ status }: { status: VideoAdvisoryStageStatus }) {
  const { label, tone, dot } = ADVISORY_STAGE_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}

export function MediaStageBadge({ status }: { status: VideoMediaStageStatus }) {
  const { label, tone, dot } = MEDIA_STAGE_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}

export function DeterministicStageBadge({ status }: { status: VideoDeterministicStageStatus }) {
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

export function StaleBadge() {
  return (
    <Badge tone="warning" dot>
      Stale
    </Badge>
  );
}
