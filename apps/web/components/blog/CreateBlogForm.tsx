"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { blogApi } from "../../lib/api/blog";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { ApiError, friendlyMessage } from "../../lib/errors";
import type { KnowledgePackSummary } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import styles from "./CreateBlogForm.module.css";

export function CreateBlogForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [topic, setTopic] = useState("");
  const [knowledgePackVersionId, setKnowledgePackVersionId] = useState("");
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
      const pipeline = await blogApi.create(workspaceId, { topic: topic.trim(), knowledgePackVersionId });
      // The pipeline response is deterministically the just-created
      // article (brief agent QUEUED). Go straight to its pipeline page —
      // real AI-job status shows there and updates itself.
      router.push(`/workspaces/${workspaceId}/blog/${pipeline.contentItem.publicId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : friendlyMessage(err));
      setPending(false);
    }
  }

  const backHref = `/workspaces/${workspaceId}/blog`;

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="Create Blog"
        description="Pick a topic and an active Knowledge Pack. The pipeline generates a content brief immediately, then walks through outline, draft, SEO, QA and scoring before human review."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Blog
          </a>
        }
      />

      {packs === null && !error && <LoadingState label="Loading Knowledge Packs…" />}
      {error && <Alert tone="danger">{error}</Alert>}

      {packs !== null && packs.length === 0 && (
        <Alert tone="warning" title="No active Knowledge Pack">
          A blog article is generated against an <strong>Active</strong> Knowledge Pack. Activate one first, then come back here.
        </Alert>
      )}

      {packs !== null && packs.length > 0 && (
        <Card>
          <form onSubmit={handleSubmit} className={styles.form} aria-label="Create Blog">
            <FormField label="Topic" hint="A clear, specific subject for the article.">
              {(field) => (
                <Input
                  {...field}
                  required
                  autoFocus
                  value={topic}
                  placeholder="e.g. How much does it cost to charge an EV at home?"
                  onChange={(e) => setTopic(e.target.value)}
                />
              )}
            </FormField>

            <FormField label="Knowledge Pack" hint="Its brand voice, keyword sets and SEO rules ground every stage.">
              {(field) => (
                <Select {...field} required value={knowledgePackVersionId} onChange={(e) => setKnowledgePackVersionId(e.target.value)}>
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

            <div className={styles.actions}>
              <Button href={backHref} variant="ghost">
                Cancel
              </Button>
              <Button type="submit" loading={pending} disabled={!topic.trim() || !knowledgePackVersionId}>
                Create Blog
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
