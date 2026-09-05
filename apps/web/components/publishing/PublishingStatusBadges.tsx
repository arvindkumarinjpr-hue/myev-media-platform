import type { PublicationTargetStatus, PublishingConnectionStatus } from "../../lib/types";
import { Badge, type BadgeTone } from "../ui/Badge";

const CONNECTION_CONFIG: Record<PublishingConnectionStatus, { label: string; tone: BadgeTone }> = {
  CONNECTED: { label: "Connected", tone: "success" },
  EXPIRED: { label: "Expired", tone: "warning" },
  REVOKED: { label: "Disconnected", tone: "neutral" },
  ERROR: { label: "Needs attention", tone: "danger" },
};

export function ConnectionStatusBadge({ status }: { status: PublishingConnectionStatus }) {
  const { label, tone } = CONNECTION_CONFIG[status];
  return <Badge tone={tone}>{label}</Badge>;
}

const TARGET_CONFIG: Record<PublicationTargetStatus, { label: string; tone: BadgeTone }> = {
  PENDING: { label: "Pending", tone: "neutral" },
  SCHEDULED: { label: "Scheduled", tone: "info" },
  QUEUED: { label: "Queued", tone: "info" },
  PUBLISHING: { label: "Publishing", tone: "info" },
  PUBLISHED: { label: "Published", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

/**
 * Module 9 Phase 9.7 (Part D/U) — never collapses a reconciliation-
 * required target into a plain, indistinguishable "Failed" badge: the
 * derived `reconciliationRequired` flag (never a stored status — see
 * PublicationTargetView's own doc comment) gets its own distinct label
 * and tone so an operator can spot it in a list at a glance.
 */
export function TargetStatusBadge({ status, reconciliationRequired }: { status: PublicationTargetStatus; reconciliationRequired?: boolean }) {
  if (reconciliationRequired) return <Badge tone="warning">Manual verification required</Badge>;
  const { label, tone } = TARGET_CONFIG[status];
  return <Badge tone={tone}>{label}</Badge>;
}
