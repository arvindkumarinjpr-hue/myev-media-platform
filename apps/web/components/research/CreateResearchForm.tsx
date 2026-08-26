"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { researchApi } from "../../lib/api/research";
import { friendlyMessage } from "../../lib/errors";
import type { KnowledgePackSummary } from "../../lib/types";
import { ErrorBanner, LoadingState } from "../ui/Feedback";
import styles from "./CreateResearchForm.module.css";

export function CreateResearchForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [topic, setTopic] = useState("");
  const [knowledgePackVersionId, setKnowledgePackVersionId] = useState("");
  const [objective, setObjective] = useState("");
  const [geography, setGeography] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    knowledgePacksApi
      .list(workspaceId)
      .then((all) => setPacks(all.filter((p) => p.status === "ACTIVE")))
      .catch((err) => setError(friendlyMessage(err)));
  }, [workspaceId]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const research = await researchApi.create(workspaceId, {
        topic,
        knowledgePackVersionId,
        objective: objective.trim() || undefined,
        geography: geography.trim() || undefined,
      });
      router.push(`/workspaces/${workspaceId}/research/${research.publicId}`);
    } catch (err) {
      setError(friendlyMessage(err));
      setPending(false);
    }
  }

  if (packs === null && !error) return <LoadingState label="Loading Knowledge Packs…" />;

  return (
    <form onSubmit={handleSubmit} className={styles.form} aria-label="New Research">
      {error && <ErrorBanner message={error} />}

      {packs !== null && packs.length === 0 ? (
        <p className={styles.noPacks}>You need an ACTIVE Knowledge Pack before research can run — activate one first.</p>
      ) : (
        <>
          <label htmlFor="research-topic" className={styles.label}>
            Topic
          </label>
          <input id="research-topic" required value={topic} onChange={(e) => setTopic(e.target.value)} className={styles.input} placeholder="e.g. EV battery swap stations" />

          <label htmlFor="research-kp" className={styles.label}>
            Knowledge Pack
          </label>
          <select id="research-kp" required value={knowledgePackVersionId} onChange={(e) => setKnowledgePackVersionId(e.target.value)} className={styles.input}>
            <option value="" disabled>
              Select an active Knowledge Pack…
            </option>
            {packs?.map((pack) => (
              <option key={pack.publicId} value={pack.publicId}>
                {pack.name}
              </option>
            ))}
          </select>

          <label htmlFor="research-objective" className={styles.label}>
            Objective <span className={styles.optional}>(optional)</span>
          </label>
          <input id="research-objective" value={objective} onChange={(e) => setObjective(e.target.value)} className={styles.input} placeholder="e.g. find content gaps" />

          <label htmlFor="research-geography" className={styles.label}>
            Geography <span className={styles.optional}>(optional)</span>
          </label>
          <input id="research-geography" value={geography} onChange={(e) => setGeography(e.target.value)} className={styles.input} placeholder="e.g. India" />

          <button type="submit" disabled={pending || !topic.trim() || !knowledgePackVersionId} className={styles.submitButton}>
            {pending ? "Starting…" : "Start Research"}
          </button>
        </>
      )}
    </form>
  );
}
