import type { ContentItemStatus, SocialPlatform } from "../../lib/types";
import { Badge } from "../ui/Badge";
import { CONTENT_ITEM_STATUS, PLATFORM_LABEL } from "./socialLabels";

export function ContentItemStatusBadge({ status }: { status: ContentItemStatus }) {
  const { label, tone, dot } = CONTENT_ITEM_STATUS[status];
  return (
    <Badge tone={tone} dot={dot}>
      {label}
    </Badge>
  );
}

export function PlatformBadge({ platform }: { platform: SocialPlatform }) {
  return <Badge tone="neutral">{PLATFORM_LABEL[platform]}</Badge>;
}
