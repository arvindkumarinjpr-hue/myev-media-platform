"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { videoApi } from "../../lib/api/video";
import { friendlyMessage } from "../../lib/errors";
import type { VideoPipeline } from "../../lib/types";
import { isPipelineBusy } from "./videoStages";

const POLL_INTERVAL_MS = 2_500;

/**
 * Loads a Video pipeline read model and polls `GET /video/:id` ONLY while
 * a generation stage is GENERATING or a media/render job is RUNNING.
 * Polling stops the moment every stage is terminal, on unmount, and on
 * navigation (effect cleanup clears the timer). A `GET` is a pure read on
 * the backend (Phase 7.4/7.5 projection), never a mutation, so polling is
 * safe. Completed/approved videos never poll. No WebSockets, no SSE —
 * the render job is a poll-friendly durable background job like any
 * other (checkpoint §20). Mirrors useBlogPipeline exactly.
 */
export function useVideoPipeline(workspaceId: string, itemId: string) {
  const [pipeline, setPipeline] = useState<VideoPipeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelledRef = useRef(false);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const schedule = useCallback((next: VideoPipeline, tick: () => void) => {
    clearTimer();
    if (isPipelineBusy(next)) {
      timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
    }
  }, []);

  const tick = useCallback(async () => {
    try {
      const next = await videoApi.get(workspaceId, itemId);
      if (cancelledRef.current) return;
      setPipeline(next);
      setError(null);
      schedule(next, tick);
    } catch (err) {
      if (!cancelledRef.current) setError(friendlyMessage(err));
    }
  }, [workspaceId, itemId, schedule]);

  useEffect(() => {
    cancelledRef.current = false;
    tick();
    return () => {
      cancelledRef.current = true;
      clearTimer();
    };
  }, [tick]);

  /** After a mutation, adopt its returned read model immediately and resume polling if work remains. */
  const applyResult = useCallback(
    (next: VideoPipeline) => {
      if (cancelledRef.current) return;
      setPipeline(next);
      setError(null);
      schedule(next, tick);
    },
    [schedule, tick],
  );

  return { pipeline, error, refetch: tick, applyResult };
}
