"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { researchApi } from "../../lib/api/research";
import { contentSeriesApi } from "../../lib/api/content-series";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { friendlyMessage } from "../../lib/errors";
import type { ContentSeries, Research } from "../../lib/types";
import { ErrorBanner, LoadingState } from "../ui/Feedback";
import styles from "./CreateTopicClusterForm.module.css";

const NEW_SERIES_VALUE = "__new__";

export function CreateTopicClusterForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [completedResearch, setCompletedResearch] = useState<Research[] | null>(null);
  const [series, setSeries] = useState<ContentSeries[] | null>(null);
  const [researchId, setResearchId] = useState("");
  const [selectedResearch, setSelectedResearch] = useState<Research | null>(null);
  const [keywordClusterTopic, setKeywordClusterTopic] = useState("");
  const [seriesSelection, setSeriesSelection] = useState("");
  const [newSeriesName, setNewSeriesName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    researchApi
      .list(workspaceId)
      .then((all) => setCompletedResearch(all.filter((r) => r.status === "COMPLETED" && (r.result?.keywordClusters.length ?? 0) > 0)))
      .catch((err) => setError(friendlyMessage(err)));
    contentSeriesApi.list(workspaceId).then(setSeries).catch(() => setSeries([]));
  }, [workspaceId]);

  function handleResearchChange(publicId: string) {
    setResearchId(publicId);
    setKeywordClusterTopic("");
    setSelectedResearch(completedResearch?.find((r) => r.publicId === publicId) ?? null);
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      let contentSeriesId: string | undefined;
      if (seriesSelection === NEW_SERIES_VALUE && newSeriesName.trim()) {
        const created = await contentSeriesApi.create(workspaceId, { name: newSeriesName.trim() });
        contentSeriesId = created.publicId;
      } else if (seriesSelection) {
        contentSeriesId = seriesSelection;
      }

      const topicCluster = await topicClustersApi.create(workspaceId, { researchId, keywordClusterTopic, contentSeriesId });
      router.push(`/workspaces/${workspaceId}/topic-clusters/${topicCluster.publicId}`);
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  if (completedResearch === null && !error) return <LoadingState label="Loading completed Research runs…" />;

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label="New Topic Cluster">
      {error && <ErrorBanner message={error} />}

      {completedResearch !== null && completedResearch.length === 0 ? (
        <p className={styles.noResearch}>You need a completed Research run with at least one keyword cluster before you can plan a topic — run Research first.</p>
      ) : (
        <>
          <label htmlFor="topic-cluster-research" className={styles.label}>
            Research run
          </label>
          <select id="topic-cluster-research" required value={researchId} onChange={(e) => handleResearchChange(e.target.value)} className={styles.input}>
            <option value="" disabled>
              Select a completed Research run…
            </option>
            {completedResearch?.map((r) => (
              <option key={r.publicId} value={r.publicId}>
                {r.topic ?? r.publicId}
              </option>
            ))}
          </select>

          <label htmlFor="topic-cluster-topic" className={styles.label}>
            Keyword cluster
          </label>
          <select
            id="topic-cluster-topic"
            required
            disabled={!selectedResearch}
            value={keywordClusterTopic}
            onChange={(e) => setKeywordClusterTopic(e.target.value)}
            className={styles.input}
          >
            <option value="" disabled>
              {selectedResearch ? "Select a keyword cluster…" : "Select a Research run first"}
            </option>
            {selectedResearch?.result?.keywordClusters.map((cluster) => (
              <option key={cluster.clusterTopic} value={cluster.clusterTopic}>
                {cluster.clusterTopic} ({cluster.primaryKeywords.length + cluster.secondaryKeywords.length} keywords)
              </option>
            ))}
          </select>

          <label htmlFor="topic-cluster-series" className={styles.label}>
            Content Series <span className={styles.optional}>(optional)</span>
          </label>
          <select id="topic-cluster-series" value={seriesSelection} onChange={(e) => setSeriesSelection(e.target.value)} className={styles.input}>
            <option value="">No series</option>
            {series?.map((s) => (
              <option key={s.publicId} value={s.publicId}>
                {s.name}
              </option>
            ))}
            <option value={NEW_SERIES_VALUE}>+ Create new series…</option>
          </select>

          {seriesSelection === NEW_SERIES_VALUE && (
            <input
              value={newSeriesName}
              onChange={(e) => setNewSeriesName(e.target.value)}
              className={styles.input}
              placeholder="New series name"
              aria-label="New series name"
            />
          )}

          <button type="submit" disabled={pending || !researchId || !keywordClusterTopic} className={styles.submitButton}>
            {pending ? "Creating…" : "Create Topic Cluster"}
          </button>
        </>
      )}
    </form>
  );
}
