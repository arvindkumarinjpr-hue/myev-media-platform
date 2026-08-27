"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { researchApi } from "../../lib/api/research";
import { friendlyMessage } from "../../lib/errors";
import type { KnowledgePackSummary } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
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
    if (pending || !topic.trim() || !knowledgePackVersionId) return;
    setPending(true);
    setError(null);
    try {
      const research = await researchApi.create(workspaceId, {
        topic: topic.trim(),
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

  const backHref = `/workspaces/${workspaceId}/research`;

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="New Research"
        description="Research reads the selected Knowledge Pack's trusted sources and configured context, then returns findings, trend signals and keyword opportunities for your topic."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Research
          </a>
        }
      />

      {packs === null && !error && <LoadingState label="Loading Knowledge Packs…" />}

      {error && <Alert tone="danger">{error}</Alert>}

      {packs !== null && packs.length === 0 && (
        <Alert tone="warning" title="No active Knowledge Pack">
          Research runs against an <strong>Active</strong> Knowledge Pack. Activate one first, then come back here.
        </Alert>
      )}

      {packs !== null && packs.length > 0 && (
        <Card>
          <form onSubmit={handleSubmit} className={styles.form} aria-label="New Research">
            <FormField label="Topic" hint="What do you want evidence, trends and keywords for?">
              {(field) => (
                <Input
                  {...field}
                  required
                  autoFocus
                  value={topic}
                  placeholder="e.g. EV battery swap stations"
                  onChange={(e) => setTopic(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Knowledge Pack" hint="Its trusted sources and brand context ground the research.">
              {(field) => (
                <Select
                  {...field}
                  required
                  value={knowledgePackVersionId}
                  onChange={(e) => setKnowledgePackVersionId(e.target.value)}
                >
                  <option value="" disabled>
                    Select an active Knowledge Pack…
                  </option>
                  {packs.map((pack) => (
                    <option key={pack.publicId} value={pack.publicId}>
                      {pack.name} (v{pack.versionNumber})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>

            <details className={styles.more}>
              <summary className={styles.moreSummary}>Refine (optional)</summary>
              <div className={styles.moreBody}>
                <FormField label="Objective" optional hint="What you're trying to learn or decide.">
                  {(field) => (
                    <Textarea
                      {...field}
                      rows={2}
                      value={objective}
                      placeholder="e.g. find content gaps competitors haven't covered"
                      onChange={(e) => setObjective(e.target.value)}
                    />
                  )}
                </FormField>
                <FormField label="Geography" optional>
                  {(field) => (
                    <Input {...field} value={geography} placeholder="e.g. India" onChange={(e) => setGeography(e.target.value)} />
                  )}
                </FormField>
              </div>
            </details>

            <div className={styles.actions}>
              <Button href={backHref} variant="ghost">
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!topic.trim() || !knowledgePackVersionId}>
                Start Research
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
