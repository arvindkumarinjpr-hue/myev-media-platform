"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { mediaApi } from "../../lib/api/media";
import { friendlyMessage } from "../../lib/errors";
import styles from "./MediaPreview.module.css";

type Kind = "image" | "audio" | "video";

/**
 * Renders a private MediaAsset (scene image / narration audio / thumbnail
 * / rendered video) via a short-lived presigned URL from
 * `GET /workspaces/:id/assets/:assetId/download-url` (MEDIA_VIEW). The
 * object-storage key never touches the client and the bucket is never
 * public. The URL expires; on a media `error` event we fetch a fresh one
 * once before giving up.
 */
export function MediaPreview({
  workspaceId,
  assetPublicId,
  kind,
  alt,
  className,
}: {
  workspaceId: string;
  assetPublicId: string;
  kind: Kind;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshedRef = useRef(false);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { downloadUrl } = await mediaApi.downloadUrl(workspaceId, assetPublicId);
      if (cancelledRef.current) return;
      setUrl(downloadUrl);
    } catch (err) {
      if (!cancelledRef.current) setError(friendlyMessage(err));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [workspaceId, assetPublicId]);

  useEffect(() => {
    cancelledRef.current = false;
    refreshedRef.current = false;
    load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  const handleMediaError = () => {
    if (refreshedRef.current) {
      setError("This preview link has expired. Reload the page to try again.");
      return;
    }
    refreshedRef.current = true;
    load();
  };

  if (loading && !url) return <div className={styles.frame} role="status" aria-label={`Loading ${alt}`}><span className={styles.spinner} aria-hidden="true" /></div>;
  if (error) return <p className={styles.error} role="status">{error}</p>;
  if (!url) return null;

  return (
    <div className={`${styles.frame} ${className ?? ""}`}>
      {/* A short-lived presigned URL to a private bucket object — not a
          stable, optimizable asset, so next/image (which would also need
          the storage host allow-listed) is the wrong tool here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {kind === "image" && <img src={url} alt={alt} className={styles.image} onError={handleMediaError} />}
      {kind === "audio" && <audio src={url} controls className={styles.audio} onError={handleMediaError} aria-label={alt} />}
      {kind === "video" && <video src={url} controls playsInline className={styles.video} onError={handleMediaError} aria-label={alt} />}
    </div>
  );
}
