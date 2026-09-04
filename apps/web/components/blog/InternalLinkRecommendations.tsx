"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { internalLinksApi } from "../../lib/api/internal-links";
import { ApiError, friendlyMessage } from "../../lib/errors";
import type { InternalLinkMutationResult, InternalLinkRecommendation, InternalLinkStatus } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { EmptyState, ErrorBanner, LoadingState } from "../ui/Feedback";
import { FormField } from "../ui/FormField";
import { Input } from "../ui/Input";
import { Meter } from "../ui/Meter";
import { Tabs, tabPanelProps, type TabItem } from "../ui/Tabs";
import { Textarea } from "../ui/Textarea";
import { LinkGraphIcon } from "../ui/icons";
import { useInternalLinks } from "./useInternalLinks";
import { ANCHOR_SOURCE_LABEL, DISCOVERY_METHOD_LABEL, INTERNAL_LINK_STATUS } from "./internalLinkLabels";
import styles from "./InternalLinkRecommendations.module.css";

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

type Filter = "ALL" | InternalLinkStatus;
const FILTERS: { id: Filter; label: string }[] = [
  { id: "GENERATED", label: "Needs review" },
  { id: "ACCEPTED", label: "Accepted" },
  { id: "REJECTED", label: "Rejected" },
  { id: "STALE", label: "Stale" },
  { id: "ALL", label: "All" },
];

export function InternalLinkRecommendations({ workspaceId, itemId, canEdit }: { workspaceId: string; itemId: string; canEdit: boolean }) {
  const { rows, error, reload, applyRows, mergeRow } = useInternalLinks(workspaceId, itemId);
  const [filter, setFilter] = useState<Filter>("GENERATED");
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [justGeneratedEmpty, setJustGeneratedEmpty] = useState(false);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: 0, GENERATED: 0, ACCEPTED: 0, REJECTED: 0, STALE: 0 };
    for (const r of rows ?? []) {
      c.ALL += 1;
      c[r.status] += 1;
    }
    return c;
  }, [rows]);

  const visible = useMemo(() => (rows ?? []).filter((r) => filter === "ALL" || r.status === filter), [rows, filter]);

  async function handleGenerate() {
    if (genBusy) return;
    setGenBusy(true);
    setGenError(null);
    setJustGeneratedEmpty(false);
    try {
      const next = await internalLinksApi.generate(workspaceId, itemId);
      applyRows(next);
      setJustGeneratedEmpty(next.length === 0);
    } catch (err) {
      setGenError(err instanceof ApiError ? err.message : friendlyMessage(err));
    } finally {
      setGenBusy(false);
    }
  }

  if (error && rows === null) return <ErrorBanner message={error} onRetry={reload} />;
  if (rows === null) return <LoadingState label="Loading internal-link recommendations…" />;

  const healthCounts = { outgoingAccepted: counts.ACCEPTED, needsReview: counts.GENERATED, rejected: counts.REJECTED, stale: counts.STALE };

  return (
    <div className={styles.wrap}>
      <div className={styles.healthStrip}>
        <span>
          <strong>{healthCounts.outgoingAccepted}</strong> accepted
        </span>
        <span>
          <strong>{healthCounts.needsReview}</strong> needs review
        </span>
        <span>
          <strong>{healthCounts.rejected}</strong> rejected
        </span>
        <span>
          <strong>{healthCounts.stale}</strong> stale
        </span>
        <Link href={`/workspaces/${workspaceId}/internal-linking`} className={styles.healthLink}>
          Workspace link health
        </Link>
      </div>

      {canEdit && (
        <div className={styles.generateRow}>
          <Button size="sm" variant="secondary" loading={genBusy} onClick={handleGenerate}>
            Generate recommendations
          </Button>
        </div>
      )}
      {canEdit && rows.some((r) => r.status === "REJECTED") && (
        <p className={styles.hint}>Previously rejected recommendations may be suggested again if content or relevance has changed since.</p>
      )}
      {genError && (
        <Alert tone="danger" role="alert" className={styles.rowAlert}>
          {genError}
        </Alert>
      )}
      {justGeneratedEmpty && rows.length === 0 && (
        <Alert tone="info" role="status" className={styles.rowAlert}>
          No relevant approved Blog targets were found.
        </Alert>
      )}

      {rows.length === 0 && !justGeneratedEmpty && (
        <EmptyState
          icon={<LinkGraphIcon />}
          title="No internal-link recommendations yet."
          description={canEdit ? "Generate recommendations to find related, already-approved Blog articles to link to." : undefined}
        />
      )}

      {rows.length > 0 && (
        <>
          <Tabs
            tabs={FILTERS.map((f): TabItem => ({ id: f.id, label: f.label, badge: counts[f.id] }))}
            active={filter}
            onChange={(id) => setFilter(id as Filter)}
            label="Filter recommendations"
            idBase="internal-link-filter"
          />
          {FILTERS.map((f) => (
            <div key={f.id} {...tabPanelProps("internal-link-filter", f.id, filter)}>
              {f.id === filter &&
                (visible.length === 0 ? (
                  <p className={styles.filterEmpty}>No {f.label.toLowerCase()} recommendations.</p>
                ) : (
                  <ul className={styles.recList}>
                    {visible.map((row) => (
                      <RecommendationRow key={row.publicId} workspaceId={workspaceId} row={row} canEdit={canEdit} onMutated={mergeRow} />
                    ))}
                  </ul>
                ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function RecommendationRow({
  workspaceId,
  row,
  canEdit,
  onMutated,
}: {
  workspaceId: string;
  row: InternalLinkRecommendation;
  canEdit: boolean;
  onMutated: (patch: InternalLinkMutationResult) => void;
}) {
  const [mode, setMode] = useState<"view" | "anchor" | "reject">("view");
  const [anchorDraft, setAnchorDraft] = useState(row.anchorText);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState<"accept" | "reject" | "anchor" | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const { label: statusLabel, tone: statusTone, dot: statusDot } = INTERNAL_LINK_STATUS[row.status];
  const canMutate = canEdit && row.status === "GENERATED";

  async function saveAnchor() {
    const trimmed = anchorDraft.trim();
    if (!trimmed || trimmed.length > 60) return;
    setBusy("anchor");
    setRowError(null);
    try {
      const result = await internalLinksApi.updateAnchor(workspaceId, row.publicId, trimmed);
      onMutated(result);
      setMode("view");
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : friendlyMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function accept() {
    setBusy("accept");
    setRowError(null);
    try {
      onMutated(await internalLinksApi.accept(workspaceId, row.publicId));
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : friendlyMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitReject() {
    const trimmed = rejectReason.trim();
    if (!trimmed) return;
    setBusy("reject");
    setRowError(null);
    try {
      onMutated(await internalLinksApi.reject(workspaceId, row.publicId, trimmed));
      setMode("view");
    } catch (err) {
      setRowError(err instanceof ApiError ? err.message : friendlyMessage(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <li className={styles.row} data-status={row.status}>
      <div className={styles.rowHead}>
        <Badge tone={statusTone} dot={statusDot}>
          {statusLabel}
        </Badge>
        <span className={styles.targetTitle}>{row.targetTitle}</span>
      </div>

      <div className={styles.rowBody}>
        {mode === "anchor" ? (
          <FormField label="Anchor text" error={anchorDraft.trim().length === 0 ? "Anchor text is required." : anchorDraft.trim().length > 60 ? "Anchor text must be 60 characters or fewer." : undefined}>
            {(field) => <Input {...field} value={anchorDraft} maxLength={60} onChange={(e) => setAnchorDraft(e.target.value)} />}
          </FormField>
        ) : (
          <p className={styles.anchorLine}>
            Anchor: <strong>{row.anchorText}</strong>
          </p>
        )}
        <Meter value={row.relevanceScore} label="Relevance score" />
      </div>

      <p className={styles.reasonLine}>{row.reason}</p>
      <details className={styles.evidence}>
        <summary>Why this recommendation?</summary>
        <ul>
          <li>Discovery: {DISCOVERY_METHOD_LABEL[row.evidence.discoveryMethod]}</li>
          {row.evidence.factors.map((f) => (
            <li key={f.id}>
              {f.label} — {f.reason}
            </li>
          ))}
          {row.evidence.anchor && <li>Anchor source: {ANCHOR_SOURCE_LABEL[row.evidence.anchor.source]}</li>}
          {row.evidence.anchor?.humanEdited && <li>Anchor text was edited by a reviewer.</li>}
        </ul>
      </details>

      <p className={styles.timestamps}>
        Generated {fmt(row.generatedAt)}
        {row.reviewedAt && <> · Reviewed {fmt(row.reviewedAt)}</>}
      </p>

      {row.status === "REJECTED" && row.rejectionReason && <p className={styles.reasonNote}>Rejection reason: {row.rejectionReason}</p>}
      {row.status === "STALE" && (
        <Alert tone="warning" role="status" className={styles.rowAlert}>
          {row.staleReason ?? "This recommendation's target or source is no longer eligible."}
        </Alert>
      )}

      {rowError && (
        <Alert tone="danger" role="alert" className={styles.rowAlert}>
          {rowError}
        </Alert>
      )}

      {canMutate && mode === "view" && (
        <div className={styles.rowActions}>
          <Button size="sm" variant="secondary" onClick={() => setMode("anchor")}>
            Edit anchor
          </Button>
          <Button size="sm" loading={busy === "accept"} onClick={accept}>
            Accept
          </Button>
          <Button size="sm" variant="danger" onClick={() => setMode("reject")}>
            Reject
          </Button>
        </div>
      )}

      {canMutate && mode === "anchor" && (
        <div className={styles.rowActions}>
          <Button size="sm" variant="ghost" disabled={busy === "anchor"} onClick={() => { setAnchorDraft(row.anchorText); setMode("view"); }}>
            Cancel
          </Button>
          <Button size="sm" loading={busy === "anchor"} disabled={!anchorDraft.trim() || anchorDraft.trim().length > 60} onClick={saveAnchor}>
            Save anchor
          </Button>
        </div>
      )}

      {canMutate && mode === "reject" && (
        <div className={styles.rejectForm}>
          <FormField label="Rejection reason" hint="Required — explain why this recommendation isn't a good fit.">
            {(field) => <Textarea {...field} rows={2} value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />}
          </FormField>
          <div className={styles.rowActions}>
            <Button size="sm" variant="ghost" disabled={busy === "reject"} onClick={() => { setRejectReason(""); setMode("view"); }}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" disabled={!rejectReason.trim()} loading={busy === "reject"} onClick={submitReject}>
              Reject
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
