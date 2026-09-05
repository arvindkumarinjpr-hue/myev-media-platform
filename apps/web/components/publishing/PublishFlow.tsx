"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { blogApi } from "../../lib/api/blog";
import { videoApi } from "../../lib/api/video";
import { publishingApi } from "../../lib/api/publishing";
import { ApiError, friendlyMessage } from "../../lib/errors";
import type { PublishingAccountView, PublishingReadinessResult } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card, CardBody } from "../ui/Card";
import { ErrorBanner, LoadingState, EmptyState } from "../ui/Feedback";
import { Input } from "../ui/Input";
import { PageHeader } from "../ui/PageHeader";
import { Stepper } from "../ui/Stepper";
import { CHANNEL_LABEL, CHANNEL_SUPPORTED_CONTENT_TYPES, readinessReasonLabel } from "./publishingLabels";
import styles from "./PublishFlow.module.css";

interface ContentOption {
  publicId: string;
  title: string;
  contentType: "BLOG" | "VIDEO";
}

const STEPS = [
  { id: "content", label: "Select content" },
  { id: "accounts", label: "Select accounts" },
  { id: "readiness", label: "Readiness" },
  { id: "schedule", label: "Publish now or schedule" },
  { id: "review", label: "Review" },
];

/**
 * Module 9 Phase 9.7 (Parts G/S/T/U) — the multi-step publication
 * creation flow: select content → select accounts → readiness preview →
 * publish now/schedule → review → submit. There is no generic
 * content-items list API in this repository (only blogApi.list() and
 * videoApi.list() separately), so this component merges the two client
 * side rather than inventing a new backend endpoint for a read-only,
 * already-cheap listing. Channel-specific "options" (title/description/
 * caption/privacy) are NOT user-editable here: publishing-readiness.
 * service.ts already resolves them from the content item itself and
 * CreatePublicationInput has no such fields — inventing UI for fields
 * the API does not accept would be dishonest.
 */
export function PublishFlow({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const [step, setStep] = useState(0);

  const [content, setContent] = useState<ContentOption[] | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState<ContentOption | null>(null);

  const [accounts, setAccounts] = useState<PublishingAccountView[] | null>(null);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<Set<string>>(new Set());

  const [readiness, setReadiness] = useState<Record<string, PublishingReadinessResult | "loading" | "error"> | null>(null);

  const [scheduleMode, setScheduleMode] = useState<"now" | "later">("now");
  const [scheduledFor, setScheduledFor] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const backHref = `/workspaces/${workspaceId}/publishing`;

  useEffect(() => {
    setContentError(null);
    Promise.all([blogApi.list(workspaceId), videoApi.list(workspaceId)])
      .then(([blogs, videos]) => {
        const options: ContentOption[] = [
          ...blogs.filter((b) => b.status === "APPROVED").map((b) => ({ publicId: b.publicId, title: b.title, contentType: "BLOG" as const })),
          ...videos.filter((v) => v.status === "APPROVED").map((v) => ({ publicId: v.publicId, title: v.title, contentType: "VIDEO" as const })),
        ];
        setContent(options);
      })
      .catch((err) => setContentError(friendlyMessage(err)));
  }, [workspaceId]);

  useEffect(() => {
    setAccountsError(null);
    publishingApi.accounts
      .list(workspaceId)
      .then(setAccounts)
      .catch((err) => setAccountsError(friendlyMessage(err)));
  }, [workspaceId]);

  const eligibleAccounts = useMemo(() => {
    if (!accounts || !selectedContent) return [];
    return accounts.filter((a) => a.connectionStatus === "CONNECTED" && CHANNEL_SUPPORTED_CONTENT_TYPES[a.channelType].includes(selectedContent.contentType));
  }, [accounts, selectedContent]);

  function toggleAccount(accountId: string) {
    setSelectedAccountIds((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  }

  function goToReadiness() {
    if (!selectedContent) return;
    setStep(2);
    const targets = Array.from(selectedAccountIds);
    setReadiness(Object.fromEntries(targets.map((id) => [id, "loading" as const])));
    targets.forEach((accountId) => {
      publishingApi.publications
        .readiness(workspaceId, selectedContent.publicId, accountId)
        .then((result) => {
          setReadiness((prev) => ({ ...prev, [accountId]: result }));
          if (!result.ready) setSelectedAccountIds((prev) => { const next = new Set(prev); next.delete(accountId); return next; });
        })
        .catch(() => setReadiness((prev) => ({ ...prev, [accountId]: "error" })));
    });
  }

  const scheduledForIso = scheduleMode === "later" && scheduledFor ? new Date(scheduledFor).toISOString() : undefined;
  const scheduleValid = scheduleMode === "now" || (!!scheduledFor && new Date(scheduledFor).getTime() > Date.now());

  async function handleSubmit() {
    if (!selectedContent || selectedAccountIds.size === 0 || submitting || !scheduleValid) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const publication = await publishingApi.publications.create(workspaceId, {
        contentItemPublicId: selectedContent.publicId,
        channelAccountPublicIds: Array.from(selectedAccountIds),
        ...(scheduledForIso ? { scheduledFor: scheduledForIso } : {}),
      });
      router.push(`/workspaces/${workspaceId}/publishing/publications/${publication.publicId}`);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : friendlyMessage(err));
      setSubmitting(false);
    }
  }

  const accountsById = useMemo(() => new Map((accounts ?? []).map((a) => [a.publicId, a])), [accounts]);

  return (
    <div className={styles.wrap}>
      <PageHeader
        title="New Publication"
        description="Publish an Approved Blog or Video to one or more connected channels, immediately or on a schedule."
        eyebrow={
          <a href={backHref} className={styles.back}>
            ← Back to Publishing
          </a>
        }
      />

      <Stepper steps={STEPS} current={step} onStepClick={(i) => i < step && setStep(i)} />

      {step === 0 && (
        <div className={styles.stepBody}>
          {contentError && <ErrorBanner message={contentError} />}
          {!contentError && content === null && <LoadingState label="Loading Approved content…" />}
          {content !== null && content.length === 0 && (
            <EmptyState title="No Approved content" description="Only Blog and Video items with status Approved can be published. Approve one first." />
          )}
          {content !== null && content.length > 0 && (
            <div className={styles.list}>
              {content.map((item) => (
                <label key={`${item.contentType}-${item.publicId}`} className={styles.optionCard}>
                  <input
                    type="radio"
                    name="content-item"
                    checked={selectedContent?.publicId === item.publicId && selectedContent?.contentType === item.contentType}
                    onChange={() => setSelectedContent(item)}
                  />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>{item.title}</span>
                    <Badge tone="neutral">{item.contentType}</Badge>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <Button href={backHref} variant="ghost">
              Cancel
            </Button>
            <Button onClick={() => setStep(1)} disabled={!selectedContent}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 1 && selectedContent && (
        <div className={styles.stepBody}>
          {accountsError && <ErrorBanner message={accountsError} />}
          {!accountsError && accounts === null && <LoadingState label="Loading channel accounts…" />}
          {accounts !== null && eligibleAccounts.length === 0 && (
            <EmptyState
              title="No connected accounts support this content type"
              description={`Connect a channel account that supports ${selectedContent.contentType === "BLOG" ? "Blog" : "Video"} content first.`}
              action={
                <Button href={`/workspaces/${workspaceId}/publishing/accounts`} variant="secondary">
                  Channel Accounts
                </Button>
              }
            />
          )}
          {eligibleAccounts.length > 0 && (
            <div className={styles.list}>
              {eligibleAccounts.map((account) => (
                <label key={account.publicId} className={styles.optionCard}>
                  <input type="checkbox" checked={selectedAccountIds.has(account.publicId)} onChange={() => toggleAccount(account.publicId)} />
                  <span className={styles.optionBody}>
                    <span className={styles.optionTitle}>{account.displayName}</span>
                    <Badge tone="neutral">{CHANNEL_LABEL[account.channelType]}</Badge>
                  </span>
                </label>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(0)}>
              Back
            </Button>
            <Button onClick={goToReadiness} disabled={selectedAccountIds.size === 0}>
              Check Readiness
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className={styles.stepBody}>
          <div className={styles.list}>
            {Array.from(selectedAccountIds.size > 0 ? selectedAccountIds : Object.keys(readiness ?? {})).map((accountId) => {
              const account = accountsById.get(accountId);
              const result = readiness?.[accountId];
              return (
                <Card key={accountId}>
                  <CardBody className={styles.readinessCard}>
                    <div className={styles.optionTitle}>{account?.displayName ?? accountId}</div>
                    {result === "loading" && <LoadingState label="Checking readiness…" />}
                    {result === "error" && <Alert tone="danger">Could not check readiness for this account.</Alert>}
                    {result && result !== "loading" && result !== "error" && (
                      <>
                        <Badge tone={result.ready ? "success" : "danger"}>{result.ready ? "Ready" : "Blocked"}</Badge>
                        {result.blockingReasons.map((reason) => (
                          <p key={reason} className={styles.reason}>
                            {readinessReasonLabel(reason)}
                          </p>
                        ))}
                        {result.warnings.map((reason) => (
                          <p key={reason} className={styles.warning}>
                            {readinessReasonLabel(reason)}
                          </p>
                        ))}
                      </>
                    )}
                  </CardBody>
                </Card>
              );
            })}
          </div>
          {readiness && Object.values(readiness).every((r) => r !== "loading") && selectedAccountIds.size === 0 && (
            <Alert tone="warning">No selected accounts are ready to publish this content. Go back and choose different accounts.</Alert>
          )}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button onClick={() => setStep(3)} disabled={selectedAccountIds.size === 0 || !readiness || Object.values(readiness).some((r) => r === "loading")}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className={styles.stepBody}>
          <div className={styles.list}>
            <label className={styles.optionCard}>
              <input type="radio" name="schedule-mode" checked={scheduleMode === "now"} onChange={() => setScheduleMode("now")} />
              <span className={styles.optionBody}>
                <span className={styles.optionTitle}>Publish now</span>
              </span>
            </label>
            <label className={styles.optionCard}>
              <input type="radio" name="schedule-mode" checked={scheduleMode === "later"} onChange={() => setScheduleMode("later")} />
              <span className={styles.optionBody}>
                <span className={styles.optionTitle}>Schedule for later</span>
                {scheduleMode === "later" && (
                  <Input type="datetime-local" value={scheduledFor} onChange={(e) => setScheduledFor(e.target.value)} aria-label="Scheduled date and time" />
                )}
              </span>
            </label>
          </div>
          {scheduleMode === "later" && !scheduleValid && <Alert tone="warning">Choose a date and time in the future.</Alert>}
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(2)}>
              Back
            </Button>
            <Button onClick={() => setStep(4)} disabled={!scheduleValid}>
              Next
            </Button>
          </div>
        </div>
      )}

      {step === 4 && selectedContent && (
        <div className={styles.stepBody}>
          {submitError && <ErrorBanner message={submitError} />}
          <Card>
            <CardBody className={styles.reviewBody}>
              <dl className={styles.reviewList}>
                <div>
                  <dt>Content</dt>
                  <dd>
                    {selectedContent.title} <Badge tone="neutral">{selectedContent.contentType}</Badge>
                  </dd>
                </div>
                <div>
                  <dt>Channels</dt>
                  <dd>
                    {Array.from(selectedAccountIds)
                      .map((id) => accountsById.get(id)?.displayName ?? id)
                      .join(", ")}
                  </dd>
                </div>
                <div>
                  <dt>When</dt>
                  <dd>{scheduleMode === "now" ? "Immediately" : new Date(scheduledFor).toLocaleString()}</dd>
                </div>
              </dl>
            </CardBody>
          </Card>
          <div className={styles.actions}>
            <Button variant="ghost" onClick={() => setStep(3)}>
              Back
            </Button>
            <Button onClick={handleSubmit} loading={submitting}>
              {scheduleMode === "now" ? "Publish" : "Schedule"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
