"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { internalLinksApi } from "../../lib/api/internal-links";
import { friendlyMessage } from "../../lib/errors";
import type { InternalLinkMutationResult, InternalLinkRecommendation } from "../../lib/types";

/**
 * Loads a Blog's internal-link recommendations (Module 8's own richer
 * read model — not the lightweight pipeline-stage snapshot). No polling:
 * unlike AI generation stages, discovery/scoring is synchronous and
 * deterministic, so a single load is enough; `reload()` covers a manual
 * refresh and `setRows`/`mergeRow` let mutation responses update state
 * directly without a refetch, mirroring useBlogPipeline's applyResult().
 */
export function useInternalLinks(workspaceId: string, itemId: string) {
  const [rows, setRows] = useState<InternalLinkRecommendation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(() => {
    setError(null);
    internalLinksApi
      .listForItem(workspaceId, itemId)
      .then((next) => {
        if (!cancelledRef.current) setRows(next);
      })
      .catch((err) => {
        if (!cancelledRef.current) setError(friendlyMessage(err));
      });
  }, [workspaceId, itemId]);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  /** After generate(), adopt the full returned list directly — it's already the source's complete, current set of live recommendations. */
  const applyRows = useCallback((next: InternalLinkRecommendation[]) => {
    if (!cancelledRef.current) setRows(next);
  }, []);

  /** After anchor-edit/accept/reject, merge the narrower mutation response into the matching row rather than refetching. */
  const mergeRow = useCallback((patch: InternalLinkMutationResult) => {
    if (cancelledRef.current) return;
    setRows((prev) => (prev ? prev.map((r) => (r.publicId === patch.publicId ? { ...r, ...patch } : r)) : prev));
  }, []);

  return { rows, error, reload: load, applyRows, mergeRow };
}
