"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { knowledgePacksApi } from "../../lib/api/knowledge-packs";
import { publishingApi } from "../../lib/api/publishing";
import { socialApi } from "../../lib/api/social";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { KnowledgePackSummary, PublishingAccountView, PublishingReadinessResult, SocialPostDetail as SocialPostDetailType } from "../../lib/types";
import { readinessReasonLabel } from "../publishing/publishingLabels";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChipsInput } from "../ui/ChipsInput";
import { LoadingState } from "../ui/Feedback";
import { FormField } from "../ui/FormField";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import { ChevronRightIcon } from "../ui/icons";
import { SocialMediaPicker } from "./SocialMediaPicker";
import { ContentItemStatusBadge, PlatformBadge } from "./SocialStatusBadge";
import { SocialVersionHistory } from "./SocialVersionHistory";
import { SOURCE_TYPE_LABEL } from "./socialLabels";
import styles from "./SocialPostDetail.module.css";

interface Caps {
  view: boolean;
  edit: boolean;
  approve: boolean;
}

interface Ctx {
  workspaceId: string;
  itemId: string;
  detail: SocialPostDetailType;
  caps: Caps;
  editable: boolean;
  run: (key: string, runner: () => Promise<unknown>) => Promise<void>;
  busy: (key: string) => boolean;
}

export function SocialPostDetail({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { permissions } = useSession();
  const [detail, setDetail] = useState<SocialPostDetailType | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    socialApi
      .get(workspaceId, itemId)
      .then(setDetail)
      .catch((err) => setLoadError(friendlyMessage(err)));
  }, [workspaceId, itemId]);

  useEffect(load, [load]);

  // Module 10 Phase 10.6 — unlike VideoPipeline's own mutations (which
  // return the full enriched read model directly), every Social mutation
  // (edit/regenerate/submit/approve/reject) returns only a minimal
  // {publicId, status, ...} shape (SocialService/SocialGenerationService
  // reuse ContentItemsService.createVersion()'s own return value
  // verbatim — see social.ts's own doc comment). So `run()` always
  // re-fetches the full detail after a successful mutation instead of
  // trusting the mutation's own response body.
  const run = useCallback(
    async (key: string, runner: () => Promise<unknown>) => {
      setBusyAction(key);
      setActionError(null);
      try {
        await runner();
        const fresh = await socialApi.get(workspaceId, itemId);
        setDetail(fresh);
        setRefreshToken((t) => t + 1);
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : friendlyMessage(err));
      } finally {
        setBusyAction(null);
      }
    },
    [workspaceId, itemId],
  );
  const busy = (key: string) => busyAction === key;

  if (loadError && !detail) return <Alert tone="danger">{loadError}</Alert>;
  if (!detail) return <LoadingState label="Loading social post…" />;

  const caps: Caps = {
    view: hasPermission(permissions, "SOCIAL_VIEW"),
    edit: hasPermission(permissions, "SOCIAL_EDIT"),
    approve: hasPermission(permissions, "SOCIAL_APPROVE"),
  };
  const editable = detail.status === "DRAFT" || detail.status === "IN_PROGRESS";
  const ctx: Ctx = { workspaceId, itemId, detail, caps, editable, run, busy };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={`/workspaces/${workspaceId}/social`}>Social Content</Link>
          <ChevronRightIcon className={styles.sep} aria-hidden="true" />
          <span aria-current="page">{detail.title || "Social post"}</span>
        </nav>
        <div className={styles.headRow}>
          <div>
            <h1 className={styles.title}>{detail.title || "Untitled social post"}</h1>
            <div className={styles.metaRow}>
              <ContentItemStatusBadge status={detail.status} />
              <PlatformBadge platform={detail.platform} />
              <span className={styles.metaText}>
                From {SOURCE_TYPE_LABEL[detail.sourceContentType] ?? detail.sourceContentType}: {detail.sourceContentItemTitle}
              </span>
            </div>
          </div>
        </div>
      </header>

      {loadError && (
        <Alert tone="warning" role="status">
          {loadError} — showing the last loaded state.
        </Alert>
      )}
      {actionError && (
        <Alert tone="danger" role="alert">
          {actionError}
        </Alert>
      )}

      <Panel title="Caption, hashtags & CTA" badge={detail.generation ? <Badge tone="info">AI-generated</Badge> : <Badge tone="neutral">Human-edited</Badge>}>
        <ContentEditor {...ctx} />
      </Panel>

      <Panel title="Media" badge={detail.media ? <Badge tone="success">Attached</Badge> : <Badge tone={detail.platform === "INSTAGRAM" ? "warning" : "neutral"}>None</Badge>}>
        <MediaSection {...ctx} />
      </Panel>

      <Panel title="Publishing readiness">
        <ReadinessSection workspaceId={workspaceId} detail={detail} />
      </Panel>

      <Panel title="Review">
        <ReviewSection {...ctx} />
      </Panel>

      <Panel title="Version history">
        <SocialVersionHistory workspaceId={workspaceId} itemId={itemId} refreshToken={refreshToken} />
      </Panel>
    </div>
  );
}

function Panel({ title, badge, children }: { title: string; badge?: ReactNode; children: ReactNode }) {
  return (
    <Card className={styles.panel}>
      <div className={styles.panelHead}>
        <h2 className={styles.panelTitle}>{title}</h2>
        {badge}
      </div>
      {children}
    </Card>
  );
}

// --- Caption / hashtags / CTA -----------------------------------

function ContentEditor({ workspaceId, itemId, detail, caps, editable, run, busy }: Ctx) {
  const [editing, setEditing] = useState(false);
  const [caption, setCaption] = useState(detail.caption ?? "");
  const [hashtags, setHashtags] = useState<string[]>(detail.hashtags);
  const [ctaObjective, setCtaObjective] = useState(detail.ctaObjective ?? "");
  const [packs, setPacks] = useState<KnowledgePackSummary[] | null>(null);
  const [knowledgePackVersionId, setKnowledgePackVersionId] = useState("");

  useEffect(() => {
    if (!editing) {
      setCaption(detail.caption ?? "");
      setHashtags(detail.hashtags);
      setCtaObjective(detail.ctaObjective ?? "");
    }
  }, [detail, editing]);

  useEffect(() => {
    if (caps.edit && editable && packs === null) {
      knowledgePacksApi
        .list(workspaceId)
        .then((all) => setPacks(all.filter((p) => p.status === "ACTIVE")))
        .catch(() => setPacks([]));
    }
  }, [workspaceId, caps.edit, editable, packs]);

  async function save() {
    await run("save", () => socialApi.edit(workspaceId, itemId, { caption: caption.trim(), hashtags, ctaObjective }));
    setEditing(false);
  }

  async function regenerate() {
    if (!knowledgePackVersionId) return;
    await run("regenerate", () => socialApi.regenerate(workspaceId, itemId, knowledgePackVersionId));
  }

  if (!editing) {
    return (
      <div className={styles.contentView}>
        <p className={styles.caption}>{detail.caption || <span className={styles.muted}>No caption</span>}</p>
        <div className={styles.hashtags}>
          {detail.hashtags.length > 0 ? detail.hashtags.map((h) => <Badge key={h} tone="neutral">{h}</Badge>) : <span className={styles.muted}>No hashtags</span>}
        </div>
        {detail.ctaObjective && <p className={styles.cta}>CTA: {detail.ctaObjective}</p>}
        {caps.edit && editable ? (
          <div className={styles.panelActions}>
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {packs !== null && (
              <>
                <Select value={knowledgePackVersionId} onChange={(e) => setKnowledgePackVersionId(e.target.value)} aria-label="Knowledge Pack for regeneration">
                  <option value="">Select a Knowledge Pack to regenerate…</option>
                  {packs.map((p) => (
                    <option key={p.publicId} value={p.publicId}>
                      {p.name} (v{p.versionNumber})
                    </option>
                  ))}
                </Select>
                <Button size="sm" variant="secondary" disabled={!knowledgePackVersionId} loading={busy("regenerate")} onClick={regenerate}>
                  Regenerate
                </Button>
              </>
            )}
          </div>
        ) : !caps.edit ? (
          <p className={styles.prereq}>Editing requires SOCIAL_EDIT.</p>
        ) : (
          <p className={styles.prereq}>This post is {detail.status.toLowerCase().replace("_", " ")} — only a Draft or In-progress post can be edited.</p>
        )}
      </div>
    );
  }

  return (
    <div className={styles.contentEdit}>
      <FormField label="Caption">{(field) => <Textarea {...field} rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} />}</FormField>
      <FormField label="Hashtags" hint="Press Enter or comma to add each hashtag.">
        {(field) => <ChipsInput {...field} value={hashtags} onChange={setHashtags} placeholder="ev, sustainability…" />}
      </FormField>
      <FormField label="CTA objective" optional>
        {(field) => <Textarea {...field} rows={2} value={ctaObjective} onChange={(e) => setCtaObjective(e.target.value)} />}
      </FormField>
      <div className={styles.panelActions}>
        <Button variant="ghost" size="sm" disabled={busy("save")} onClick={() => setEditing(false)}>
          Cancel
        </Button>
        <Button size="sm" loading={busy("save")} disabled={!caption.trim()} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}

// --- Media --------------------------------------------------------

function MediaSection({ workspaceId, itemId, detail, editable, run, busy }: Ctx) {
  return (
    <SocialMediaPicker
      workspaceId={workspaceId}
      sourceContentItemPublicId={detail.sourceContentItemPublicId}
      sourceContentType={detail.sourceContentType}
      platform={detail.platform}
      currentMedia={detail.media}
      editable={editable}
      busy={busy("media")}
      onSelect={(mediaAssetPublicId) => run("media", () => socialApi.edit(workspaceId, itemId, { mediaAssetPublicId }))}
      onDetach={() => run("media", () => socialApi.edit(workspaceId, itemId, { mediaAssetPublicId: null }))}
    />
  );
}

// --- Readiness ------------------------------------------------------

function ReadinessSection({ workspaceId, detail }: { workspaceId: string; detail: SocialPostDetailType }) {
  const [accounts, setAccounts] = useState<PublishingAccountView[] | null>(null);
  const [result, setResult] = useState<PublishingReadinessResult | "loading" | "error" | null>(null);

  useEffect(() => {
    publishingApi.accounts
      .list(workspaceId)
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, [workspaceId]);

  const account = accounts?.find((a) => a.channelType === detail.platform && a.connectionStatus === "CONNECTED") ?? null;

  useEffect(() => {
    if (!account) {
      setResult(null);
      return;
    }
    setResult("loading");
    publishingApi.publications
      .readiness(workspaceId, detail.publicId, account.publicId)
      .then(setResult)
      .catch(() => setResult("error"));
  }, [workspaceId, detail.publicId, account]);

  return (
    <div className={styles.readiness}>
      {detail.platform === "FACEBOOK" && detail.media?.assetType === "IMAGE" && (
        <Alert tone="warning">Facebook image posting is not implemented yet — this post will need to be caption-only or use video media to actually publish.</Alert>
      )}
      {accounts === null && <LoadingState label="Checking connected accounts…" />}
      {accounts !== null && !account && (
        <Alert tone="info">
          No connected {detail.platform === "FACEBOOK" ? "Facebook" : "Instagram"} account yet — connect one in{" "}
          <Link href={`/workspaces/${workspaceId}/publishing/accounts`}>Publishing → Channel Accounts</Link> to see full execution readiness.
        </Alert>
      )}
      {result === "loading" && <LoadingState label="Checking readiness…" />}
      {result === "error" && <Alert tone="danger">Could not check readiness for the connected account.</Alert>}
      {result && result !== "loading" && result !== "error" && (
        <>
          <Badge tone={result.ready ? "success" : "danger"}>{result.ready ? "Ready to publish" : "Not ready"}</Badge>
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
    </div>
  );
}

// --- Review / approval / publishing handoff --------------------------

function ReviewSection({ workspaceId, itemId, detail, caps, run, busy }: Ctx) {
  const [comment, setComment] = useState("");

  if (detail.status === "APPROVED") {
    return (
      <div className={styles.reviewBody}>
        <Alert tone="success" role="status">
          This social post is <strong>Approved</strong> and read-only. Caption, hashtags and media cannot change further — hand it off to Publishing when ready.
        </Alert>
        <Button href={`/workspaces/${workspaceId}/publishing/publications/new?contentItemId=${detail.publicId}`}>Send to Publishing</Button>
      </div>
    );
  }

  if (detail.status === "REVIEW") {
    return caps.approve ? (
      <div className={styles.reviewForm}>
        <FormField label="Comment" hint="Optional for approve, required for reject">
          {(field) => <Textarea {...field} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />}
        </FormField>
        <div className={styles.panelActions}>
          <Button size="sm" loading={busy("approve")} onClick={() => run("approve", () => socialApi.approve(workspaceId, itemId, comment.trim() || undefined))}>
            Approve
          </Button>
          <Button
            size="sm"
            variant="danger"
            disabled={!comment.trim()}
            loading={busy("reject")}
            onClick={() => run("reject", () => socialApi.reject(workspaceId, itemId, comment.trim()))}
          >
            Reject
          </Button>
        </div>
      </div>
    ) : (
      <p className={styles.prereq}>This post is awaiting review by someone with SOCIAL_APPROVE.</p>
    );
  }

  return caps.edit ? (
    <Button size="sm" loading={busy("submit")} onClick={() => run("submit", () => socialApi.submitForReview(workspaceId, itemId))}>
      Submit for review
    </Button>
  ) : (
    <p className={styles.prereq}>Submitting for review requires SOCIAL_EDIT.</p>
  );
}
