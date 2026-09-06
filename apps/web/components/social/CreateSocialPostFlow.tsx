"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { contentItemsApi } from "../../lib/api/content-items";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { socialApi } from "../../lib/api/social";
import { ApiError, friendlyMessage } from "../../lib/errors";
import type { ContentItemSummary, KnowledgePackSummary, SocialPlatform } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ErrorBanner, LoadingState, EmptyState } from "../ui/Feedback";
import { FormField } from "../ui/FormField";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { Stepper } from "../ui/Stepper";
import { SOURCE_TYPE_LABEL, PLATFORM_LABEL } from "./socialLabels";
import styles from "./CreateSocialPostFlow.module.css";

const STEPS = [
  { id: "source", label: "Select source" },
  { id: "platform", label: "Select platform" },
  { id: "review", label: "Review" },
  { id: "generate", label: "Generate" },
];

const PLATFORMS: SocialPlatform[] = ["FACEBOOK", "INSTAGRAM"];

/**
 * Module 10 Phase 10.6 (Part F) — the "Create Social Post" wizard. Never
 * creates a placeholder SocialPost before generation succeeds: step 4's
 * "Generate" button is the FIRST and only call to
 * `POST .../social-posts` (Phase 10.2's own create+generate-atomically
 * semantics) — there is nothing to navigate away from or clean up if
 * generation fails, since nothing was created yet.
 */
export function CreateSocialPostFlow({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [sources, setSources] = useState<ContentItemSummary[] | null>(null);
  const [sourcesError, setSourcesError] = useState<string | null>(null);
  const [selectedSource, setSelectedSource] = useState<ContentItemSummary | null>(null);

  const [platform, setPlatform] = useState<SocialPlatform | null>(null);

  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [packsError, setPacksError] = useState<string | null>(null);
  const [knowledgePackVersionId, setKnowledgePackVersionId] = useState("");

  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const backHref = `/workspaces/${workspaceId}/social`;

  // Part G — only APPROVED Blog/Video, workspace-isolated by construction
  // (contentItemsApi already scopes to :workspaceId), never a freeform
  // source input. A role without VIDEO_VIEW (e.g. Content Writer) simply
  // gets an empty VIDEO list back — not an error — so this naturally
  // narrows to what each role can actually see.
  useEffect(() => {
    setSourcesError(null);
    Promise.all([
      contentItemsApi.list(workspaceId, { contentType: "BLOG", status: "APPROVED" }),
      contentItemsApi.list(workspaceId, { contentType: "VIDEO", status: "APPROVED" }),
    ])
      .then(([blogs, videos]) => setSources([...blogs, ...videos]))
      .catch((err) => setSourcesError(friendlyMessage(err)));
  }, [workspaceId]);

  useEffect(() => {
    knowledgePacksApi
      .list(workspaceId)
      .then((all) => setPacks(all.filter((p) => p.status === "ACTIVE")))
      .catch((err) => setPacksError(friendlyMessage(err)));
  }, [workspaceId]);

  const sourcePreviewLabel = useMemo(() => {
    if (!selectedSource) return "";
    return `${SOURCE_TYPE_LABEL[selectedSource.contentType] ?? selectedSource.contentType}: ${selectedSource.title || "Untitled"}`;
  }, [selectedSource]);

  async function handleGenerate() {
    if (!selectedSource || !platform || !knowledgePackVersionId || generating) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const created = await socialApi.create(workspaceId, {
        sourceContentItemId: selectedSource.publicId,
        platform,
        knowledgePackVersionId,
      });
      router.push(`/workspaces/${workspaceId}/social/${created.publicId}`);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : friendlyMessage(err));
      setGenerating(false);
    }
  }

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="New Social Post"
        description="Generate a Facebook or Instagram post from an already-Approved Blog or Video — the caption and hashtags are written from that content, never from scratch."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Social Content
          </a>
        }
      />

      <Stepper steps={STEPS} current={step} onStepClick={(i) => i < step && setStep(i)} />

      {step === 0 && (
        <div className={styles.stepBody}>
          {sourcesError && <ErrorBanner message={sourcesError} />}
          {!sourcesError && sources === null && <LoadingState label="Loading Approved Blog and Video content…" />}
          {sources !== null && sources.length === 0 && (
            <EmptyState title="No Approved Blog or Video content" description="Only Blog and Video items with status Approved can be a Social source. Approve one first." />
          )}
          {sources !== null && sources.length > 0 && (
            <div className={styles.list}>
              {sources.map((item) => (
                <label key={`${item.contentType}-${item.publicId}`} className={styles.optionCard}>
                  <input
                    type="radio"
                    name="source-item"
                    checked={selectedSource?.publicId === item.publicId && selectedSource?.contentType === item.contentType}
                    onChange={() => setSelectedSource(item)}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>{item.title || "Untitled"}</span>
                    <Badge tone="neutral">{SOURCE_TYPE_LABEL[item.contentType] ?? item.contentType}</Badge>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <Button href={backHref} variant="ghost">
              Cancel
            </Button>
            <Button onClick={() => setStep(1)} disabled={!selectedSource}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 1 && selectedSource && (
        <div className={styles.stepBody}>
          <div className={styles.list}>
            {PLATFORMS.map((p) => (
              <label key={p} className={styles.optionCard}>
                <input type="radio" name="platform" checked={platform === p} onChange={() => setPlatform(p)} />
                <span className={styles.optionBody}>
                  <span className={styles.optionTitle}>{PLATFORM_LABEL[p]}</span>
                  {p === "INSTAGRAM" && <span className={styles.hint}>Requires compatible media to publish later.</span>}
                </span>
              </label>
            ))}
          </div>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button onClick={() => setStep(2)} disabled={!platform}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 2 && selectedSource && platform && (
        <div className={styles.stepBody}>
          <dl className={styles.reviewList}>
            <div>
              <dt>Source</dt>
              <dd>{sourcePreviewLabel}</dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>{PLATFORM_LABEL[platform]}</dd>
            </div>
          </dl>

          {packsError && <ErrorBanner message={packsError} />}
          {!packsError && packs === null && <LoadingState label="Loading Knowledge Packs…" />}
          {packs !== null && (
            <FormField label="Knowledge Pack" hint="Its brand voice and tone ground the generated caption and hashtags.">
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
          )}

          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={!knowledgePackVersionId}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 3 && selectedSource && platform && (
        <div className={styles.stepBody}>
          {generateError && <ErrorBanner message={generateError} />}
          <Alert tone="info">
            Generating a real caption and hashtag set for {PLATFORM_LABEL[platform]} from <strong>{sourcePreviewLabel}</strong>. This calls the AI provider now — nothing is created until it
            succeeds.
          </Alert>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(2)} disabled={generating}>
              Back
            </Button>
            <Button onClick={handleGenerate} loading={generating}>
              Generate
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
