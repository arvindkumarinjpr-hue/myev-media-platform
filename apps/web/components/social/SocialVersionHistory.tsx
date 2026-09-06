"use client";

import { useCallback, useEffect, useState } from "react";
import { socialApi } from "../../lib/api/social";
import { friendlyMessage } from "../../lib/errors";
import type { SocialPostVersion } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Card, CardBody } from "../ui/Card";
import { LoadingState } from "../ui/Feedback";
import { fmtDateTime } from "./socialLabels";
import styles from "./SocialVersionHistory.module.css";

/**
 * Module 10 Phase 10.6 (Part N) — every version's full approved-together
 * state, inline (not a link to a separate per-version page — a
 * SocialPost's ContentVersion has no detail route of its own, unlike a
 * Knowledge Pack version). Answers "what caption + hashtags + media were
 * approved together?" directly: each card is one immutable version.
 */
export function SocialVersionHistory({ workspaceId, itemId, refreshToken }: { workspaceId: string; itemId: string; refreshToken?: number }) {
  const [versions, setVersions] = useState<SocialPostVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    socialApi
      .listVersions(workspaceId, itemId)
      .then(setVersions)
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId, itemId]);

  useEffect(load, [load, refreshToken]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (versions === null) return <LoadingState label="Loading version history…" />;

  return (
    <div className={styles.wrap}>
      {versions
        .slice()
        .reverse()
        .map((v) => (
          <Card key={v.publicId} className={styles.card}>
            <CardBody className={styles.body}>
              <div className={styles.head}>
                <span className={styles.version}>Version {v.versionNumber}</span>
                {v.isCurrent && <Badge tone="success">Current</Badge>}
                <span className={styles.muted}>{fmtDateTime(v.createdAt)}</span>
                <span className={styles.muted}>{v.generation ? "AI-generated" : "Human-edited"}</span>
              </div>
              <p className={styles.caption}>{v.caption || <span className={styles.muted}>No caption</span>}</p>
              <div className={styles.hashtags}>
                {v.hashtags.length > 0 ? v.hashtags.map((h) => <Badge key={h} tone="neutral">{h}</Badge>) : <span className={styles.muted}>No hashtags</span>}
              </div>
              {v.ctaObjective && <p className={styles.cta}>CTA: {v.ctaObjective}</p>}
              <p className={styles.media}>Media: {v.media ? `${v.media.assetType} (${v.media.status})` : "None attached"}</p>
            </CardBody>
          </Card>
        ))}
    </div>
  );
}
