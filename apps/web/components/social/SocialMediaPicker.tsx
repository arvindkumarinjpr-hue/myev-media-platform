"use client";

import { useEffect, useState } from "react";
import { contentItemsApi } from "../../lib/api/content-items";
import { videoApi } from "../../lib/api/video";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { SocialMediaSummary, SocialPlatform } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { MediaPreview } from "../video/MediaPreview";
import { REEL_TARGET_PLATFORM_BY_SOCIAL_PLATFORM } from "./socialLabels";
import styles from "./SocialMediaPicker.module.css";

interface Candidate {
  key: string;
  label: string;
  mediaAssetPublicId: string;
  kind: "image" | "video";
}

/**
 * Module 10 Phase 10.6 (Part K) — existing-media-only selection. Never
 * uploads, generates, or renders anything. The ONLY candidates surfaced
 * are: the source Blog's own `featuredMediaAssetId` (Part K: "surface
 * compatible existing featured media"), and — for a Video source — that
 * video's own current render, but ONLY when its `targetPlatform` matches
 * this post's platform (mirrors SocialGenerationService's own
 * REEL_TARGET_PLATFORM_BY_SOCIAL_PLATFORM exactly; see socialLabels.ts's
 * doc comment). Never an arbitrary render, never a cross-workspace asset —
 * both source calls are workspace-scoped by construction. A candidate the
 * viewer lacks permission to resolve (e.g. a Content Writer viewing a
 * Video-sourced post they can see via SOCIAL_VIEW but cannot read the
 * Video pipeline for) is silently omitted, not an error — this section is
 * advisory; readiness (SOCIAL_MEDIA_REQUIRED/INCOMPATIBLE) remains the
 * real authority on whether the current selection is actually usable.
 */
export function SocialMediaPicker({
  workspaceId,
  sourceContentItemPublicId,
  sourceContentType,
  platform,
  currentMedia,
  editable,
  onSelect,
  onDetach,
  busy,
}: {
  workspaceId: string;
  sourceContentItemPublicId: string;
  sourceContentType: "BLOG" | "VIDEO";
  platform: SocialPlatform;
  currentMedia: SocialMediaSummary | null;
  editable: boolean;
  onSelect: (mediaAssetPublicId: string) => void;
  onDetach: () => void;
  busy: boolean;
}) {
  const { permissions } = useSession();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setCandidates([]);

    async function loadCandidates() {
      try {
        if (sourceContentType === "BLOG") {
          if (!hasPermission(permissions, "BLOG_VIEW")) return;
          const blog = await contentItemsApi.get(workspaceId, sourceContentItemPublicId);
          if (cancelled || !blog.featuredMediaAssetId) return;
          setCandidates([{ key: "blog-featured", label: "Blog's featured image", mediaAssetPublicId: blog.featuredMediaAssetId, kind: "image" }]);
        } else {
          if (!hasPermission(permissions, "VIDEO_VIEW")) return;
          const pipeline = await videoApi.get(workspaceId, sourceContentItemPublicId);
          if (cancelled) return;
          const expectedTarget = REEL_TARGET_PLATFORM_BY_SOCIAL_PLATFORM[platform];
          const matches = pipeline.videoScript?.targetPlatform === expectedTarget && pipeline.render.status === "READY" && pipeline.render.renderedVideoPublicId;
          if (!matches) return;
          setCandidates([
            {
              key: "video-render",
              label: `Existing ${expectedTarget.replace(/_/g, " ").toLowerCase()} render`,
              mediaAssetPublicId: pipeline.render.renderedVideoPublicId!,
              kind: "video",
            },
          ]);
        }
      } catch (err) {
        // A 403/404 here reflects a real permission/data boundary
        // (Part K's own "silently omit, never error" rule) — anything
        // else is worth surfacing since it may mean the candidate is
        // genuinely unavailable rather than just unauthorized.
        if (!cancelled && !(err instanceof ApiError && (err.status === 403 || err.status === 404))) {
          setLoadError(friendlyMessage(err));
        }
      }
    }

    loadCandidates();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sourceContentItemPublicId, sourceContentType, platform, permissions]);

  const currentIsCandidate = candidates.some((c) => c.mediaAssetPublicId === currentMedia?.mediaAssetPublicId);

  return (
    <div className={styles.wrap}>
      {currentMedia ? (
        <div className={styles.current}>
          <MediaPreview workspaceId={workspaceId} assetPublicId={currentMedia.mediaAssetPublicId} kind={currentMedia.assetType === "VIDEO" ? "video" : "image"} alt="Attached social media" className={styles.preview} />
          <Badge tone="info">
            {currentMedia.assetType} · {currentMedia.status}
          </Badge>
          {editable && (
            <Button size="sm" variant="secondary" loading={busy} onClick={onDetach}>
              Detach media
            </Button>
          )}
        </div>
      ) : (
        <p className={styles.none}>
          No media attached. {platform === "INSTAGRAM" ? "Instagram requires media to publish." : "Facebook can still publish this as a caption-only post."}
        </p>
      )}

      {loadError && <Alert tone="warning">{loadError}</Alert>}

      {editable && candidates.filter((c) => !currentIsCandidate || c.mediaAssetPublicId !== currentMedia?.mediaAssetPublicId).length > 0 && (
        <div className={styles.candidates}>
          <p className={styles.candidatesTitle}>Existing compatible media from the source:</p>
          {candidates.map((c) => (
            <div key={c.key} className={styles.candidateRow}>
              <MediaPreview workspaceId={workspaceId} assetPublicId={c.mediaAssetPublicId} kind={c.kind} alt={c.label} className={styles.candidatePreview} />
              <span>{c.label}</span>
              <Button size="sm" loading={busy} onClick={() => onSelect(c.mediaAssetPublicId)}>
                Use this
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
