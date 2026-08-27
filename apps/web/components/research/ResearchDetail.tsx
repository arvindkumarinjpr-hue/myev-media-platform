"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { researchApi } from "../../lib/api/research";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { Research } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { DescriptionList } from "../ui/DescriptionList";
import { ExternalLink, hostnameOf } from "../ui/ExternalLink";
import { Badge } from "../ui/Badge";
import { LoadingState } from "../ui/Feedback";
import { Meter } from "../ui/Meter";
import { ChevronRightIcon, ResearchIcon, TopicClusterIcon, TrendDownIcon, TrendFlatIcon, TrendUpIcon } from "../ui/icons";
import { KeywordClusterView } from "../shared/KeywordClusterView";
import { fromResearchKeyword } from "../shared/keywords";
import { ResearchStatusBadge } from "./ResearchStatusBadge";
import { RESEARCH_STATUS, TREND_DIRECTION, TREND_FRESHNESS, failureExplanation } from "./researchLabels";
import styles from "./ResearchDetail.module.css";

const POLL_INTERVAL_MS = 1_500;

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function ResearchDetail({ workspaceId, researchId }: { workspaceId: string; researchId: string }) {
  const { permissions } = useSession();
  const [research, setResearch] = useState<Research | null>(null);
  const [packName, setPackName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const r = await researchApi.get(workspaceId, researchId);
        if (cancelled) return;
        setResearch(r);
        setError(null);
        if (r.status === "QUEUED" || r.status === "RUNNING") {
          timerRef.current = setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch (err) {
        if (!cancelled) setError(friendlyMessage(err));
      }
    }

    tick();

    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [workspaceId, researchId]);

  // Resolve the Knowledge Pack name from its version id (research only
  // carries the id). Best-effort — a miss just hides the field.
  const kpVersionId = research?.knowledgePackVersionId;
  useEffect(() => {
    if (!kpVersionId) return;
    let cancelled = false;
    knowledgePacksApi
      .list(workspaceId)
      .then((packs) => {
        if (!cancelled) setPackName(packs.find((p) => p.publicId === kpVersionId)?.name ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceId, kpVersionId]);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!research) return <LoadingState label="Loading research…" />;

  const isProcessing = research.status === "QUEUED" || research.status === "RUNNING";
  const isFailed = research.status === "FAILED" || research.status === "TIMED_OUT";
  const isCompleted = research.status === "COMPLETED" && research.result;
  const canPlan = hasPermission(permissions, "TOPIC_CLUSTER_MANAGE");
  const hasClusters = (research.result?.keywordClusters.length ?? 0) > 0;

  const meta = [
    { term: "Created", value: formatDateTime(research.createdAt) },
    ...(packName ? [{ term: "Knowledge Pack", value: packName }] : []),
    ...(research.completedAt && isCompleted ? [{ term: "Completed", value: formatDateTime(research.completedAt) }] : []),
  ];

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={`/workspaces/${workspaceId}/research`}>Research</Link>
          <ChevronRightIcon className={styles.sep} />
          <span aria-current="page">{research.topic ?? "Research"}</span>
        </nav>
        <div className={styles.headRow}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{research.topic ?? "Research"}</h1>
            <div className={styles.metaRow}>
              <ResearchStatusBadge status={research.status} />
              <span className={styles.metaDate}>{formatDateTime(research.createdAt)}</span>
              {packName && <span className={styles.metaDate}>{packName}</span>}
            </div>
          </div>
          {isCompleted && hasClusters && canPlan && (
            <Button
              href={`/workspaces/${workspaceId}/topic-clusters/new?research=${research.publicId}`}
              iconLeft={<TopicClusterIcon />}
            >
              Create Topic Cluster
            </Button>
          )}
        </div>
      </header>

      {isProcessing && <ProcessingPanel status={research.status} meta={meta} />}

      {isFailed && (
        <FailurePanel
          research={research}
          backHref={`/workspaces/${workspaceId}/research`}
          newHref={`/workspaces/${workspaceId}/research/new`}
        />
      )}

      {isCompleted && research.result && <CompletedReport result={research.result} />}
    </div>
  );
}

function ProcessingPanel({ status, meta }: { status: Research["status"]; meta: { term: string; value: string }[] }) {
  return (
    <Card className={styles.stateCard}>
      <div className={styles.processing}>
        <span className={styles.spinner} aria-hidden="true" />
        <div>
          <p className={styles.stateTitle} role="status">
            Research is in progress
          </p>
          <p className={styles.stateBody}>
            {status === "QUEUED" ? "It's queued and will start shortly." : "Gathering evidence, trends and keywords."} This
            page will update automatically once it&apos;s done — you can also come back later.
          </p>
        </div>
      </div>
      <DescriptionList items={meta} className={styles.stateMeta} />
    </Card>
  );
}

function FailurePanel({ research, backHref, newHref }: { research: Research; backHref: string; newHref: string }) {
  const isTimeout = research.status === "TIMED_OUT";
  return (
    <Card className={styles.stateCard}>
      <p className={styles.stateTitle}>{isTimeout ? "Research timed out" : "Research didn't complete"}</p>
      <Alert tone="danger" role="alert">
        {failureExplanation(research.errorCode, research.errorMessageSafe)}
      </Alert>
      <DescriptionList
        className={styles.stateMeta}
        items={[
          { term: "Topic", value: research.topic ?? "—" },
          { term: "Created", value: formatDateTime(research.createdAt) },
        ]}
      />
      <div className={styles.stateActions}>
        <Button href={backHref} variant="secondary">
          Back to Research
        </Button>
        <Button href={newHref}>Start new Research</Button>
      </div>
    </Card>
  );
}

function CompletedReport({ result }: { result: NonNullable<Research["result"]> }) {
  const sourceByCitationId = new Map(result.sources.filter((s) => s.sourceId).map((s) => [s.sourceId, s]));
  const dedup = result.deduplication;
  const removed = dedup ? dedup.duplicateFindingsRemoved + dedup.duplicateSourcesRemoved : 0;

  return (
    <div className={styles.report}>
      {dedup?.requiresManualReview && (
        <Alert tone="warning" title="Manual review needed" role="status">
          Automated duplicate detection could not be completed for this research — the findings and sources below may contain
          duplicates. Please review them manually.
        </Alert>
      )}

      {result.executiveSummary?.trim() ? (
        <Card className={styles.summaryCard}>
          <h2 className={styles.sectionTitle}>Executive summary</h2>
          <p className={styles.summary}>{result.executiveSummary}</p>
        </Card>
      ) : null}

      {result.findings.length > 0 && (
        <Card>
          <h2 className={styles.sectionTitle}>Key findings</h2>
          <ul className={styles.findingList}>
            {result.findings.map((finding, i) => {
              const sourceBacked = finding.provenance === "source_backed";
              return (
                <li key={i} className={styles.finding}>
                  <div className={styles.findingTop}>
                    <p className={styles.findingText}>{finding.summary}</p>
                    <Badge tone={sourceBacked ? "success" : "neutral"}>
                      {sourceBacked ? "Source-backed" : "AI inference"}
                    </Badge>
                  </div>
                  {finding.evidence && <p className={styles.findingEvidence}>{finding.evidence}</p>}
                  {finding.sourceIds.length > 0 && (
                    <p className={styles.findingCitations}>
                      <span className={styles.citationLabel}>Sources:</span>
                      {finding.sourceIds.map((id) => {
                        const source = sourceByCitationId.get(id);
                        return source ? (
                          <ExternalLink key={id} href={source.url}>
                            {source.title ?? hostnameOf(source.url)}
                          </ExternalLink>
                        ) : null;
                      })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {result.trendSignals.length > 0 && (
        <Card>
          <h2 className={styles.sectionTitle}>Trend intelligence</h2>
          <ul className={styles.trendList}>
            {result.trendSignals.map((signal, i) => {
              const dir = TREND_DIRECTION[signal.direction];
              const DirIcon =
                signal.direction === "rising" ? TrendUpIcon : signal.direction === "declining" ? TrendDownIcon : TrendFlatIcon;
              return (
                <li key={i} className={styles.trend}>
                  <div className={styles.trendHead}>
                    <span className={styles.trendTopic}>{signal.topic}</span>
                    <Badge tone={dir.tone}>
                      <DirIcon aria-hidden="true" className={styles.dirIcon} /> {dir.label}
                    </Badge>
                    <Badge tone="neutral">{TREND_FRESHNESS[signal.freshness]}</Badge>
                  </div>
                  {signal.evidence && <p className={styles.trendEvidence}>{signal.evidence}</p>}
                  <DescriptionList
                    layout="row"
                    items={[
                      { term: "Confidence", value: <Meter value={signal.confidence} label={`Confidence for ${signal.topic}`} /> },
                      {
                        term: "Opportunity",
                        value: <Meter value={signal.opportunityScore} label={`Opportunity score for ${signal.topic}`} />,
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {result.keywordClusters.length > 0 && (
        <Card>
          <h2 className={styles.sectionTitle}>Keyword opportunities</h2>
          <KeywordClusterView
            clusters={result.keywordClusters.map((c) => ({
              title: c.clusterTopic,
              primary: c.primaryKeywords.map(fromResearchKeyword),
              secondary: c.secondaryKeywords.map(fromResearchKeyword),
            }))}
          />
        </Card>
      )}

      {result.contentAngles.length > 0 && (
        <Card>
          <h2 className={styles.sectionTitle}>Content angles</h2>
          <ul className={styles.angleList}>
            {result.contentAngles.map((angle, i) => (
              <li key={i} className={styles.angle}>
                {angle}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <h2 className={styles.sectionTitle}>Sources</h2>
        {result.sources.length > 0 ? (
          <ul className={styles.sourceList}>
            {result.sources.map((source, i) => (
              <li key={i} className={styles.source}>
                <ExternalLink href={source.url}>{source.title ?? hostnameOf(source.url)}</ExternalLink>
                <Badge tone="neutral">{source.sourceType}</Badge>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.muted}>No verified sources were reachable at research time.</p>
        )}
        <p className={styles.sourceFootnote}>
          {result.citationIntegrity
            ? `Citations checked against the Knowledge Pack's trusted sources${
                result.citationIntegrity.invalidCitationsRemoved > 0
                  ? `; ${result.citationIntegrity.invalidCitationsRemoved} unverifiable citation(s) removed`
                  : ""
              }.`
            : null}
          {dedup && !dedup.requiresManualReview && removed > 0
            ? ` ${dedup.duplicateFindingsRemoved} duplicate finding(s) and ${dedup.duplicateSourcesRemoved} duplicate source(s) removed automatically.`
            : null}
        </p>
      </Card>
    </div>
  );
}
