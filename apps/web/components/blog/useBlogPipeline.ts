"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { blogApi } from "../../lib/api/blog";
import { friendlyMessage } from "../../lib/errors";
import type { BlogPipeline } from "../../lib/types";

const POLL_INTERVAL_MS = 2_500;

/** True while at least one AI-backed generation stage is still QUEUED/RUNNING. */
export function isPipelineBusy(p: BlogPipeline): boolean {
  return [p.brief, p.outline, p.draft, p.seo].some((s) => s.status === "GENERATING");
}

/**
 * Loads a Blog pipeline read model and polls ONLY while a generation
 * stage is running. Polling stops the moment every stage is terminal, on
 * unmount, and on navigation (the effect cleanup clears the timer). A
 * `GET` is a read on the backend (Phase 6.3 projection) — never a
 * mutation — so polling is safe. Completed articles never poll.
 */
export function useBlogPipeline(workspaceId: string, itemId: string) {
  const [pipeline, setPipeline] = useState<BlogPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const tick = useCallback(async () => {
    try {
      const next = await blogApi.get(workspaceId, itemId);
      if (cancelledRef.current) return;
      setPipeline(next);
      setError(null);
      clearTimer();
      if (isPipelineBusy(next)) {
        timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    } catch (err) {
      if (!cancelledRef.current) setError(friendlyMessage(err));
    }
  }, [workspaceId, itemId]);

  useEffect(() => {
    cancelledRef.current = false;
    tick();
    return () => {
      cancelledRef.current = true;
      clearTimer();
    };
  }, [tick]);

  /** After a mutation, adopt its returned read model and resume polling if needed. */
  const applyResult = useCallback(
    (next: BlogPipeline) => {
      if (cancelledRef.current) return;
      setPipeline(next);
      setError(null);
      clearTimer();
      if (isPipelineBusy(next)) {
        timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    },
    [tick],
  );

  return { pipeline, error, refetch: tick, applyResult };
}
