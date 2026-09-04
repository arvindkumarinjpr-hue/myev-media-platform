import type { BadgeTone } from "../ui/Badge";
import type { InternalLinkAnchorSource, InternalLinkDiscoveryMethod, InternalLinkStatus } from "../../lib/types";

export const INTERNAL_LINK_STATUS: Record<InternalLinkStatus, { label: string; tone: BadgeTone; dot?: boolean }> = {
  GENERATED: { label: "Needs review", tone: "warning", dot: true },
  ACCEPTED: { label: "Accepted", tone: "success" },
  REJECTED: { label: "Rejected", tone: "danger" },
  STALE: { label: "Stale", tone: "neutral" },
};

/** Mirrors the backend's own DISCOVERY_METHOD_LABELS (internal-link-scoring.ts) — used only for the evidence disclosure, never for the primary row (row.reason already carries this). */
export const DISCOVERY_METHOD_LABEL: Record<InternalLinkDiscoveryMethod, string> = {
  cluster: "Same content series / topic cluster",
  "keyword-cluster": "Shared keyword-cluster topic",
  "kp-keyword": "Shared Knowledge Pack keywords",
  "token-fallback": "Related by shared terms",
};

/** Mirrors the backend's AnchorSelectionSource (internal-link-anchor.ts). */
export const ANCHOR_SOURCE_LABEL: Record<InternalLinkAnchorSource, string> = {
  "target-primary-keyword": "The target's primary keyword",
  "target-title-subphrase": "A phrase from the target's title",
  "target-title-fallback": "The target's full title (fallback)",
};
