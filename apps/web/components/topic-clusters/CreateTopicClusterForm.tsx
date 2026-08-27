"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { researchApi } from "../../lib/api/research";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { contentSeriesApi } from "../../lib/api/content-series";
import { topicClustersApi } from "../../lib/api/topic-clusters";
import { friendlyMessage } from "../../lib/errors";
import type { ContentSeries, KeywordCluster, Research } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { DescriptionList } from "../ui/DescriptionList";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { LoadingState } from "../ui/Feedback";
import { PageHeader } from "../ui/PageHeader";
import { Stepper } from "../ui/Stepper";
import { INTENT_LABEL, fromResearchKeyword } from "../shared/keywords";
import styles from "./CreateTopicClusterForm.module.css";

const STEPS = [
  { id: "research", label: "Research" },
  { id: "cluster", label: "Keyword cluster" },
  { id: "series", label: "Content series" },
  { id: "review", label: "Review" },
];

const NO_SERIES = "";
const NEW_SERIES = "__new__";

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function CreateTopicClusterForm({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const preselectedResearch = useSearchParams()?.get("research") ?? null;

  const [completedResearch, setCompletedResearch] = useState<Research[] | null>(null);
  const [series, setSeries] = useState<ContentSeries[] | null>(null);
  const [packNames, setPackNames] = useState<Map<string, string>>(new Map());
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState(0);
  const [researchId, setResearchId] = useState("");
  const [clusterTopic, setClusterTopic] = useState("");
  const [seriesSelection, setSeriesSelection] = useState<string>(NO_SERIES);
  const [newSeriesName, setNewSeriesName] = useState("");
  const [pending, setPending] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    researchApi
      .list(workspaceId)
      .then((all) => setCompletedResearch(all.filter((r) => r.status === "COMPLETED" && (r.result?.keywordClusters.length ?? 0) > 0)))
      .catch((err) => setLoadError(friendlyMessage(err)));
    contentSeriesApi.list(workspaceId).then(setSeries).catch(() => setSeries([]));
    knowledgePacksApi
      .list(workspaceId)
      .then((packs) => setPackNames(new Map(packs.map((p) => [p.publicId, p.name]))))
      .catch(() => undefined);
  }, [workspaceId]);

  // Preselect the Research run passed via ?research= and jump to step 2.
  useEffect(() => {
    if (!preselectedResearch || !completedResearch) return;
    if (completedResearch.some((r) => r.publicId === preselectedResearch)) {
      setResearchId(preselectedResearch);
      setStep((s) => (s === 0 ? 1 : s));
    }
  }, [preselectedResearch, completedResearch]);

  const selectedResearch = useMemo(
    () => completedResearch?.find((r) => r.publicId === researchId) ?? null,
    [completedResearch, researchId],
  );
  const selectedCluster = useMemo(
    () => selectedResearch?.result?.keywordClusters.find((c) => c.clusterTopic === clusterTopic) ?? null,
    [selectedResearch, clusterTopic],
  );

  async function handleCreate() {
    if (pending || !researchId || !clusterTopic) return;
    setPending(true);
    setSubmitError(null);
    try {
      let contentSeriesId: string | undefined;
      if (seriesSelection === NEW_SERIES && newSeriesName.trim()) {
        contentSeriesId = (await contentSeriesApi.create(workspaceId, { name: newSeriesName.trim() })).publicId;
      } else if (seriesSelection && seriesSelection !== NEW_SERIES) {
        contentSeriesId = seriesSelection;
      }
      const created = await topicClustersApi.create(workspaceId, {
        researchId,
        keywordClusterTopic: clusterTopic,
        contentSeriesId,
      });
      router.push(`/workspaces/${workspaceId}/topic-clusters/${created.publicId}`);
    } catch (err) {
      setSubmitError(friendlyMessage(err));
      setPending(false);
    }
  }

  const backHref = `/workspaces/${workspaceId}/topic-clusters`;

  if (completedResearch === null && !loadError) {
    return (
      <div className={styles.wrap}>
        <PageHeader title="Create Topic Cluster" />
        <LoadingState label="Loading completed Research runs…" />
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="Create Topic Cluster"
        description="Promote a keyword cluster from a completed Research run into a reusable planning cluster."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Topic Clusters
          </a>
        }
      />

      {loadError && <Alert tone="danger">{loadError}</Alert>}

      {!loadError && completedResearch && completedResearch.length === 0 && (
        <Alert tone="warning" title="No usable Research yet">
          You need a completed Research run with at least one keyword cluster before you can plan a topic. Run Research first.
        </Alert>
      )}

      {!loadError && completedResearch && completedResearch.length > 0 && (
        <>
          <Stepper steps={STEPS} current={step} onStepClick={(i) => i < step && setStep(i)} className={styles.stepper} />

          {submitError && <Alert tone="danger">{submitError}</Alert>}

          {step === 0 && (
            <StepShell
              title="Select a Research run"
              description="Only completed runs that produced keyword clusters are shown."
              onNext={() => setStep(1)}
              nextDisabled={!researchId}
            >
              <fieldset className={styles.optionList}>
                <legend className="sr-only">Research run</legend>
                {completedResearch.map((r) => (
                  <label key={r.publicId} className={styles.option}>
                    <input
                      type="radio"
                      name="research"
                      value={r.publicId}
                      checked={researchId === r.publicId}
                      onChange={() => {
                        setResearchId(r.publicId);
                        setClusterTopic("");
                      }}
                    />
                    <span className={styles.optionBody}>
                      <span className={styles.optionTitle}>{r.topic ?? "Untitled research"}</span>
                      <span className={styles.optionMeta}>
                        {formatDate(r.createdAt)}
                        {packNames.get(r.knowledgePackVersionId) ? ` · ${packNames.get(r.knowledgePackVersionId)}` : ""}
                        {` · ${r.result?.keywordClusters.length ?? 0} cluster(s)`}
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            </StepShell>
          )}

          {step === 1 && (
            <StepShell
              title="Select a keyword cluster"
              description={selectedResearch?.topic ? `From “${selectedResearch.topic}”.` : undefined}
              onBack={() => setStep(0)}
              onNext={() => setStep(2)}
              nextDisabled={!clusterTopic}
            >
              <fieldset className={styles.optionList}>
                <legend className="sr-only">Keyword cluster</legend>
                {selectedResearch?.result?.keywordClusters.map((c) => (
                  <ClusterOption
                    key={c.clusterTopic}
                    cluster={c}
                    checked={clusterTopic === c.clusterTopic}
                    onSelect={() => setClusterTopic(c.clusterTopic)}
                  />
                ))}
              </fieldset>
            </StepShell>
          )}

          {step === 2 && (
            <StepShell
              title="Attach to a Content Series"
              description="Optional — group related clusters together."
              onBack={() => setStep(1)}
              onNext={() => setStep(3)}
              nextDisabled={seriesSelection === NEW_SERIES && !newSeriesName.trim()}
            >
              <fieldset className={styles.optionList}>
                <legend className="sr-only">Content series</legend>
                <label className={styles.option}>
                  <input type="radio" name="series" checked={seriesSelection === NO_SERIES} onChange={() => setSeriesSelection(NO_SERIES)} />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>No series</span>
                  </span>
                </label>
                {series?.map((s) => (
                  <label key={s.publicId} className={styles.option}>
                    <input type="radio" name="series" value={s.publicId} checked={seriesSelection === s.publicId} onChange={() => setSeriesSelection(s.publicId)} />
                    <span className={styles.optionBody}>
                      <span className={styles.optionTitle}>{s.name}</span>
                    </span>
                  </label>
                ))}
                <label className={styles.option}>
                  <input type="radio" name="series" checked={seriesSelection === NEW_SERIES} onChange={() => setSeriesSelection(NEW_SERIES)} />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>Create a new series</span>
                  </span>
                </label>
                {seriesSelection === NEW_SERIES && (
                  <div className={styles.newSeries}>
                    <FormField label="New series name">
                      {(field) => (
                        <Input
                          {...field}
                          value={newSeriesName}
                          placeholder="e.g. Charging 101"
                          onChange={(e) => setNewSeriesName(e.target.value)}
                        />
                      )}
                    </FormField>
                  </div>
                )}
              </fieldset>
            </StepShell>
          )}

          {step === 3 && (
            <StepShell title="Review and create" onBack={() => setStep(2)}>
              <DescriptionList
                layout="stack"
                items={[
                  { term: "Research", value: selectedResearch?.topic ?? "—" },
                  { term: "Keyword cluster", value: selectedCluster?.clusterTopic ?? "—" },
                  {
                    term: "Primary keywords",
                    value: (selectedCluster?.primaryKeywords ?? []).map((k) => k.keyword).join(", ") || "—",
                  },
                  {
                    term: "Content series",
                    value:
                      seriesSelection === NEW_SERIES
                        ? `${newSeriesName.trim() || "(unnamed)"} (new)`
                        : seriesSelection
                          ? series?.find((s) => s.publicId === seriesSelection)?.name ?? "—"
                          : "None",
                  },
                ]}
              />
              <div className={styles.reviewActions}>
                <Button type="button" loading={pending} onClick={handleCreate}>
                  Create Topic Cluster
                </Button>
              </div>
            </StepShell>
          )}
        </>
      )}
    </div>
  );
}

function StepShell({
  title,
  description,
  children,
  onBack,
  onNext,
  nextDisabled,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  onBack?: () => void;
  onNext?: () => void;
  nextDisabled?: boolean;
}) {
  return (
    <Card>
      <h2 className={styles.stepTitle}>{title}</h2>
      {description && <p className={styles.stepDescription}>{description}</p>}
      <div className={styles.stepBody}>{children}</div>
      {(onBack || onNext) && (
        <div className={styles.stepNav}>
          {onBack ? (
            <Button variant="ghost" type="button" onClick={onBack}>
              Back
            </Button>
          ) : (
            <span />
          )}
          {onNext && (
            <Button type="button" onClick={onNext} disabled={nextDisabled}>
              Next
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function ClusterOption({ cluster, checked, onSelect }: { cluster: KeywordCluster; checked: boolean; onSelect: () => void }) {
  const primary = cluster.primaryKeywords.map(fromResearchKeyword);
  const secondary = cluster.secondaryKeywords.map(fromResearchKeyword);
  const topIntents = Array.from(new Set(primary.map((k) => INTENT_LABEL[k.intent]))).slice(0, 3);
  return (
    <label className={styles.option}>
      <input type="radio" name="cluster" value={cluster.clusterTopic} checked={checked} onChange={onSelect} />
      <span className={styles.optionBody}>
        <span className={styles.optionTitle}>{cluster.clusterTopic}</span>
        <span className={styles.optionMeta}>
          {primary.length} primary · {secondary.length} secondary
          {topIntents.length > 0 ? ` · ${topIntents.join(", ")}` : ""}
        </span>
        {primary.length > 0 && (
          <span className={styles.optionKeywords}>{primary.slice(0, 5).map((k) => k.term).join(", ")}</span>
        )}
      </span>
    </label>
  );
}
