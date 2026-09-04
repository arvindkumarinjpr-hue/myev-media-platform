"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { blogApi } from "../../lib/api/blog";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { BlogPipeline, BlogScoreFeedback } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { DescriptionList } from "../ui/DescriptionList";
import { LoadingState } from "../ui/Feedback";
import { Meter } from "../ui/Meter";
import { Stepper } from "../ui/Stepper";
import { Textarea } from "../ui/Textarea";
import { ChevronRightIcon, CheckCircleIcon, XCircleIcon } from "../ui/icons";
import { ContentItemStatusBadge, DeterministicStageBadge, GenerationStageBadge } from "./BlogStageBadge";
import { InternalLinkRecommendations } from "./InternalLinkRecommendations";
import { useBlogPipeline } from "./useBlogPipeline";
import { currentStepIndex, deriveStage } from "./pipelineStage";
import {
  PIPELINE_STAGE_LABEL,
  PIPELINE_STEPS,
  QA_CHECK_LABEL,
  REVIEW_GATE_LABEL,
  SCORE_CATEGORY_LABEL,
  stageFailureExplanation,
} from "./blogLabels";
import styles from "./BlogPipelineDetail.module.css";

function fmt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

interface Caps {
  edit: boolean;
  seoEdit: boolean;
  seoScore: boolean;
  approve: boolean;
  viewScore: boolean;
}

export function BlogPipelineDetail({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { permissions } = useSession();
  const { pipeline, error, applyResult } = useBlogPipeline(workspaceId, itemId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, runner: () => Promise<BlogPipeline>) => {
      setBusyAction(key);
      setActionError(null);
      try {
        applyResult(await runner());
      } catch (err) {
        setActionError(err instanceof ApiError ? err.message : friendlyMessage(err));
      } finally {
        setBusyAction(null);
      }
    },
    [applyResult],
  );

  if (error && !pipeline) return <Alert tone="danger">{error}</Alert>;
  if (!pipeline) return <LoadingState label="Loading blog pipeline…" />;

  const p = pipeline;
  const caps: Caps = {
    edit: hasPermission(permissions, "BLOG_EDIT"),
    seoEdit: hasPermission(permissions, "SEO_EDIT"),
    seoScore: hasPermission(permissions, "SEO_SCORE"),
    approve: hasPermission(permissions, "BLOG_APPROVE"),
    viewScore: hasPermission(permissions, "BLOG_VIEW"),
  };
  const stage = deriveStage(p);
  const mutable = p.contentItem.status === "IN_PROGRESS" || p.contentItem.status === "DRAFT";
  const busy = (k: string) => busyAction === k;
  const ctx = { workspaceId, itemId, p, caps, run, busy, mutable };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={`/workspaces/${workspaceId}/blog`}>Blog</Link>
          <ChevronRightIcon className={styles.sep} aria-hidden="true" />
          <span aria-current="page">{p.contentItem.title || "Article"}</span>
        </nav>
        <div className={styles.headRow}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{p.contentItem.title || "Untitled article"}</h1>
            <div className={styles.metaRow}>
              <ContentItemStatusBadge status={p.contentItem.status} />
              <span className={styles.metaText}>Stage: {PIPELINE_STAGE_LABEL[stage]}</span>
              {p.publishReady && <Badge tone="success">Publish ready</Badge>}
            </div>
          </div>
        </div>
      </header>

      <Card className={styles.stepperCard}>
        <Stepper steps={PIPELINE_STEPS.map((s) => ({ id: s.id, label: s.label }))} current={currentStepIndex(p)} />
      </Card>

      {error && (
        <Alert tone="warning" role="status">
          {error} — showing the last loaded state.
        </Alert>
      )}
      {actionError && (
        <Alert tone="danger" role="alert">
          {actionError}
        </Alert>
      )}

      <div className={styles.stages}>
        <BriefPanel {...ctx} />
        <OutlinePanel {...ctx} />
        <DraftPanel {...ctx} />
        <SeoPanel {...ctx} />
        <InternalLinkingPanel {...ctx} />
        <QaPanel {...ctx} />
        <ScorePanel {...ctx} />
        <ReviewPanel {...ctx} />
      </div>
    </div>
  );
}

interface PanelCtx {
  workspaceId: string;
  itemId: string;
  p: BlogPipeline;
  caps: Caps;
  run: (key: string, runner: () => Promise<BlogPipeline>) => Promise<void>;
  busy: (k: string) => boolean;
  mutable: boolean;
}

function StagePanel({
  title,
  badge,
  description,
  children,
  actions,
}: {
  title: string;
  badge: ReactNode;
  description?: string;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Card className={styles.panel}>
      <div className={styles.panelHead}>
        <div>
          <h2 className={styles.panelTitle}>{title}</h2>
          {description && <p className={styles.panelDesc}>{description}</p>}
        </div>
        <div>{badge}</div>
      </div>
      {children}
      {actions && <div className={styles.panelActions}>{actions}</div>}
    </Card>
  );
}

function FailureNote({ reason }: { reason: string | null }) {
  return (
    <Alert tone="danger" role="alert" className={styles.failure}>
      {stageFailureExplanation(reason)}
    </Alert>
  );
}

function GeneratingNote({ label }: { label: string }) {
  return (
    <p className={styles.generating} role="status">
      <span className={styles.spinner} aria-hidden="true" /> {label} — this updates automatically.
    </p>
  );
}

// --- Brief -----------------------------------------------------------------

function BriefPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.brief;
  const a = s.artifact;
  return (
    <StagePanel
      title="Brief"
      badge={<GenerationStageBadge status={s.status} />}
      description="Search intent, audience, keyword targets and the CTA objective."
      actions={
        caps.edit && mutable ? (
          <>
            {(s.status === "PENDING" || s.status === "FAILED") && (
              <Button size="sm" loading={busy("brief.gen")} onClick={() => run("brief.gen", () => blogApi.generateBrief(workspaceId, itemId))}>
                {s.status === "FAILED" ? "Regenerate brief" : "Generate brief"}
              </Button>
            )}
            {(s.status === "READY" || s.status === "APPROVED") && (
              <Button size="sm" variant="secondary" loading={busy("brief.regen")} onClick={() => run("brief.regen", () => blogApi.generateBrief(workspaceId, itemId))}>
                Regenerate
              </Button>
            )}
            {s.status === "READY" && (
              <Button size="sm" loading={busy("brief.approve")} onClick={() => run("brief.approve", () => blogApi.approveBrief(workspaceId, itemId))}>
                Approve brief
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {s.status === "GENERATING" && <GeneratingNote label="Generating the brief" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {a && (
        <>
          <DescriptionList
            className={styles.dl}
            items={[
              { term: "Search intent", value: <Badge tone="info">{a.searchIntent}</Badge> },
              { term: "Target audience", value: a.targetAudience },
              { term: "Primary keyword", value: <strong>{a.primaryKeyword}</strong> },
              {
                term: "Secondary keywords",
                value: a.secondaryKeywords.length ? (
                  <span className={styles.chips}>
                    {a.secondaryKeywords.map((k) => (
                      <Badge key={k} tone="neutral">
                        {k}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "—"
                ),
              },
              { term: "CTA objective", value: a.ctaObjective },
              ...(s.approvedAt ? [{ term: "Approved", value: fmt(s.approvedAt) }] : []),
            ]}
          />
          {a.rationale && <p className={styles.rationale}>{a.rationale}</p>}
        </>
      )}
    </StagePanel>
  );
}

// --- Outline --------------------------------------------------------------

function OutlinePanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.outline;
  const a = s.artifact;
  const prereqMet = p.brief.status === "APPROVED";
  return (
    <StagePanel
      title="Outline"
      badge={<GenerationStageBadge status={s.status} />}
      description="H1, the ordered H2/H3 hierarchy with each section's purpose, and the FAQ plan."
      actions={
        caps.edit && mutable ? (
          <>
            {prereqMet && (s.status === "PENDING" || s.status === "FAILED") && (
              <Button size="sm" loading={busy("outline.gen")} onClick={() => run("outline.gen", () => blogApi.generateOutline(workspaceId, itemId))}>
                {s.status === "FAILED" ? "Regenerate outline" : "Generate outline"}
              </Button>
            )}
            {(s.status === "READY" || s.status === "APPROVED") && (
              <Button size="sm" variant="secondary" loading={busy("outline.regen")} onClick={() => run("outline.regen", () => blogApi.generateOutline(workspaceId, itemId))}>
                Regenerate
              </Button>
            )}
            {s.status === "READY" && (
              <Button size="sm" loading={busy("outline.approve")} onClick={() => run("outline.approve", () => blogApi.approveOutline(workspaceId, itemId))}>
                Approve outline
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && (
        <p className={styles.prereq}>Approve the brief first — the outline is generated from it.</p>
      )}
      {s.status === "GENERATING" && <GeneratingNote label="Generating the outline" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {a && (
        <div className={styles.outline}>
          <p className={styles.h1}>{a.h1}</p>
          <ol className={styles.sectionList}>
            {a.sections.map((sec, i) => (
              <li key={i} className={styles.section} data-level={sec.level}>
                <span className={styles.sectionHeading}>
                  <Badge tone="neutral">H{sec.level}</Badge> {sec.heading}
                </span>
                <span className={styles.sectionPurpose}>{sec.purpose}</span>
              </li>
            ))}
          </ol>
          {a.faqPlan.length > 0 && (
            <div className={styles.faqPlan}>
              <p className={styles.subhead}>Planned FAQs</p>
              <ul>
                {a.faqPlan.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </StagePanel>
  );
}

// --- Draft --------------------------------------------------------------

function DraftPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.draft;
  const prereqMet = p.outline.status === "APPROVED";
  const draftArtifact = s.artifact;
  return (
    <StagePanel
      title="Draft"
      badge={<GenerationStageBadge status={s.status} pending={s.pendingFinalization} />}
      description="The generated article. Each generation is saved as a new immutable content version — history is never overwritten."
      actions={
        caps.edit && mutable ? (
          <>
            {prereqMet && (s.status === "PENDING" || s.status === "FAILED") && (
              <Button size="sm" loading={busy("draft.gen")} onClick={() => run("draft.gen", () => blogApi.generateDraft(workspaceId, itemId))}>
                {s.status === "FAILED" ? "Regenerate draft" : "Generate draft"}
              </Button>
            )}
            {s.status === "READY" && (
              <Button size="sm" variant="secondary" loading={busy("draft.regen")} onClick={() => run("draft.regen", () => blogApi.generateDraft(workspaceId, itemId))}>
                Regenerate draft
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Approve the outline first — the draft is written from it.</p>}
      {s.status === "GENERATING" && <GeneratingNote label="Writing the draft" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {s.status === "READY" && s.pendingFinalization && (
        <Alert tone="info" role="status" className={styles.failure}>
          The draft is generated. It becomes an immutable content version the moment the next stage (SEO) runs.
        </Alert>
      )}
      {s.contentVersionPublicId && (
        <p className={styles.versionRef}>
          Current version: <code>{s.contentVersionPublicId.slice(0, 8)}</code>
          {s.aiJobPublicId && <span className={styles.muted}> · generated by AI job {s.aiJobPublicId.slice(0, 8)}</span>}
        </p>
      )}
      {draftArtifact && <DraftReader a={draftArtifact} />}
      <p className={styles.note}>
        Inline editing and full version history land in a later phase — the draft is read-only here.
      </p>
    </StagePanel>
  );
}

function DraftReader({ a }: { a: NonNullable<BlogPipeline["draft"]["artifact"]> }) {
  return (
    <article className={styles.reader}>
      <p>{a.introduction}</p>
      {a.bodySections.map((sec, i) => (
        <section key={i}>
          <h3 className={styles.readerHeading}>{sec.heading}</h3>
          <p>{sec.content}</p>
        </section>
      ))}
      <h3 className={styles.readerHeading}>Conclusion</h3>
      <p>{a.conclusion}</p>
      <p className={styles.readerCta}>{a.cta}</p>
      {a.faqs.length > 0 && (
        <>
          <h3 className={styles.readerHeading}>FAQ</h3>
          <dl className={styles.readerFaq}>
            {a.faqs.map((f, i) => (
              <div key={i}>
                <dt>{f.question}</dt>
                <dd>{f.answer}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </article>
  );
}

// --- SEO --------------------------------------------------------------

function SeoPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.seo;
  const a = s.artifact;
  const prereqMet = p.draft.status === "READY";
  const [showSchema, setShowSchema] = useState(false);
  return (
    <StagePanel
      title="SEO"
      badge={<GenerationStageBadge status={s.status} pending={s.pendingFinalization} />}
      description="Meta title, meta description, URL slug and a schema.org markup suggestion."
      actions={
        caps.seoEdit && mutable ? (
          <>
            {prereqMet && (s.status === "PENDING" || s.status === "FAILED") && (
              <Button size="sm" loading={busy("seo.gen")} onClick={() => run("seo.gen", () => blogApi.generateSeo(workspaceId, itemId))}>
                {s.status === "FAILED" ? "Regenerate SEO" : "Generate SEO"}
              </Button>
            )}
            {s.status === "READY" && (
              <Button size="sm" variant="secondary" loading={busy("seo.regen")} onClick={() => run("seo.regen", () => blogApi.generateSeo(workspaceId, itemId))}>
                Regenerate
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>A generated draft is required before the SEO pass.</p>}
      {s.status === "GENERATING" && <GeneratingNote label="Generating SEO metadata" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {a && (
        <>
          <DescriptionList
            className={styles.dl}
            items={[
              { term: "Meta title", value: a.metaTitle },
              { term: "Meta description", value: a.metaDescription },
              { term: "URL slug", value: <code>/{a.urlSlug}</code> },
            ]}
          />
          <button type="button" className={styles.disclosure} aria-expanded={showSchema} onClick={() => setShowSchema((v) => !v)}>
            {showSchema ? "Hide" : "Show"} schema.org markup
          </button>
          {showSchema && <pre className={styles.schema}>{JSON.stringify(a.schemaMarkup, null, 2)}</pre>}
        </>
      )}
      <p className={styles.note}>Publishing and live search-engine submission are handled by a later module.</p>
    </StagePanel>
  );
}

// --- Internal linking ----------------------------------------------------

function InternalLinkingPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.internalLinking;
  const prereqMet = p.seo.status === "READY";
  return (
    <StagePanel
      title="Internal linking"
      badge={<DeterministicStageBadge status={s.status} />}
      description="Deterministic, editorial internal-link recommendations from already-approved Blog articles — reviewed and approved by a human, never inserted automatically."
      actions={
        caps.edit && mutable && s.status === "PENDING" && prereqMet ? (
          <Button size="sm" loading={busy("link.run")} onClick={() => run("link.run", () => blogApi.runInternalLinking(workspaceId, itemId))}>
            Complete internal-linking stage
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Complete the SEO pass first.</p>}
      {/* Legacy pre-Module-8 completions only — every stage completed via runInternalLinking() today reaches "suggestions_generated" or "no_related_content_found" instead. */}
      {s.status === "COMPLETED" && s.reason === "engine_not_available" && (
        <Alert tone="info" role="status" className={styles.failure}>
          This stage completed before the linking engine was available — no suggestions were generated.
        </Alert>
      )}
      {s.status === "COMPLETED" && s.reason !== "engine_not_available" && (
        <InternalLinkRecommendations workspaceId={workspaceId} itemId={itemId} canEdit={caps.seoEdit} />
      )}
    </StagePanel>
  );
}

// --- QA ----------------------------------------------------------------

function QaPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.qa;
  const prereqMet = p.draft.status === "READY" && p.internalLinking.status === "COMPLETED";
  return (
    <StagePanel
      title="Quality assurance"
      badge={<DeterministicStageBadge status={s.status} />}
      description="Six deterministic checks: grammar, readability, structure, keyword stuffing, duplicate content and brand compliance."
      actions={
        caps.edit && mutable && prereqMet && (s.status === "PENDING" || s.checks.length > 0) ? (
          <Button size="sm" variant={s.status === "COMPLETED" ? "secondary" : "primary"} loading={busy("qa.run")} onClick={() => run("qa.run", () => blogApi.runQa(workspaceId, itemId))}>
            {s.status === "COMPLETED" ? "Re-run QA" : "Run QA"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>A generated draft and a completed internal-linking stage are required first.</p>}
      {s.checks.length > 0 && (
        <ul className={styles.qaList}>
          {s.checks.map((c) => (
            <li key={c.id} className={styles.qaItem}>
              <span className={styles.qaIcon} aria-hidden="true">
                {c.passed ? <CheckCircleIcon className={styles.pass} /> : <XCircleIcon className={styles.fail} />}
              </span>
              <div>
                <p className={styles.qaLabel}>
                  {QA_CHECK_LABEL[c.id] ?? c.label} <Badge tone={c.passed ? "success" : "danger"}>{c.passed ? "Pass" : "Fail"}</Badge>
                </p>
                <p className={styles.qaExplain}>{c.explanation}</p>
                {c.evidence.length > 0 && (
                  <ul className={styles.qaEvidence}>
                    {c.evidence.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </StagePanel>
  );
}

// --- Score ------------------------------------------------------------

function ScorePanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.scoring;
  const prereqMet = p.qa.status === "COMPLETED";
  const [feedback, setFeedback] = useState<BlogScoreFeedback | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!caps.viewScore) return;
    let cancelled = false;
    blogApi
      .score(workspaceId, itemId)
      .then((f) => {
        if (!cancelled) setFeedback(f);
      })
      .catch((err) => {
        if (!cancelled) setLoadErr(friendlyMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, itemId, caps.viewScore, s.contentScorePublicId]);

  return (
    <StagePanel
      title="Content score"
      badge={
        s.status === "COMPLETED" && s.passed !== null ? (
          <Badge tone={s.passed ? "success" : "danger"}>{s.passed ? "Passed" : "Below threshold"}</Badge>
        ) : (
          <DeterministicStageBadge status={s.status} />
        )
      }
      description="An explainable 0–100 score across the five universal categories plus the Blog dimension. The article must reach the pass threshold before it can go to human review."
      actions={
        caps.seoScore && mutable && prereqMet ? (
          <Button size="sm" variant={s.status === "COMPLETED" ? "secondary" : "primary"} loading={busy("score.run")} onClick={() => run("score.run", () => blogApi.runScore(workspaceId, itemId))}>
            {s.status === "COMPLETED" ? "Re-score" : "Run content score"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Complete QA first.</p>}
      {!caps.viewScore && <p className={styles.prereq}>You don&apos;t have permission to view the content score.</p>}
      {loadErr && <Alert tone="warning" role="status" className={styles.failure}>{loadErr}</Alert>}

      {s.status === "COMPLETED" && s.overallScore !== null && (
        <div className={styles.scoreHead}>
          <div className={styles.overall}>
            <span className={styles.overallValue}>{s.overallScore}</span>
            <span className={styles.overallOf}>/ 100</span>
          </div>
          <p className={styles.threshold}>
            Pass threshold: <strong>{s.passThreshold ?? "—"}</strong>
            {" · "}
            {s.passed ? "This article passes." : "This article is below the threshold and cannot go to review yet."}
          </p>
        </div>
      )}

      {feedback && (
        <>
          <div className={styles.categoryGrid}>
            {(Object.keys(feedback.categoryScores) as (keyof typeof feedback.categoryScores)[]).map((cat) => (
              <div key={cat} className={styles.category}>
                <span className={styles.categoryName}>{SCORE_CATEGORY_LABEL[cat] ?? cat}</span>
                <Meter value={feedback.categoryScores[cat]} label={`${SCORE_CATEGORY_LABEL[cat] ?? cat} score`} />
              </div>
            ))}
            <div className={styles.category}>
              <span className={styles.categoryName}>{feedback.dimension.label || "Blog"} dimension</span>
              <Meter value={feedback.dimension.score} label="Blog dimension score" tone="neutral" />
            </div>
          </div>

          {feedback.recommendations.length > 0 && (
            <div className={styles.recs}>
              <p className={styles.subhead}>Recommendations</p>
              <ul>
                {feedback.recommendations.map((r) => (
                  <li key={r.id} className={styles.rec}>
                    <Badge tone={r.priority === "critical" || r.priority === "high" ? "danger" : "neutral"}>{r.priority}</Badge>
                    <span>{r.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {feedback.factors.length > 0 && (
            <details className={styles.factors}>
              <summary>Factor breakdown ({feedback.factors.length})</summary>
              <ul>
                {feedback.factors.map((f) => (
                  <li key={f.id}>
                    <span className={styles.factorLabel}>
                      {f.label}
                      {f.category && <Badge tone="neutral">{SCORE_CATEGORY_LABEL[f.category] ?? f.category}</Badge>}
                    </span>
                    <span className={styles.factorReason}>{f.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </StagePanel>
  );
}

// --- Review ---------------------------------------------------------------

function ReviewPanel({ workspaceId, itemId, p, caps, run, busy }: PanelCtx) {
  const [comment, setComment] = useState("");
  const status = p.contentItem.status;

  if (status === "APPROVED") {
    return (
      <StagePanel title="Review & publish" badge={<Badge tone="success">Approved</Badge>}>
        <Alert tone="success" role="status" className={styles.failure}>
          This article is approved and <strong>publish ready</strong>. Publishing to WordPress and other channels is delivered by a later module.
        </Alert>
      </StagePanel>
    );
  }

  if (status === "REVIEW") {
    return (
      <StagePanel
        title="Human review"
        badge={<Badge tone="warning" dot>In review</Badge>}
        description="A reviewer with approval authority decides whether this article goes forward. Human approval is always required."
      >
        {caps.approve ? (
          <div className={styles.reviewForm}>
            <label htmlFor="review-comment" className={styles.subhead}>
              Comment <span className={styles.muted}>(required to reject)</span>
            </label>
            <Textarea id="review-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional for approve, required for reject" />
            <div className={styles.panelActions}>
              <Button size="sm" loading={busy("approve")} onClick={() => run("approve", () => blogApi.approve(workspaceId, itemId, comment.trim() || undefined))}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!comment.trim()}
                loading={busy("reject")}
                onClick={() => run("reject", () => blogApi.reject(workspaceId, itemId, comment.trim()))}
              >
                Reject
              </Button>
            </div>
          </div>
        ) : (
          <p className={styles.prereq}>This article is awaiting review by someone with approval permission.</p>
        )}
      </StagePanel>
    );
  }

  const gates = p.reviewGatesUnmet;
  return (
    <StagePanel
      title="Submit for review"
      badge={p.canSubmitForReview ? <Badge tone="success">Ready</Badge> : <Badge tone="neutral">Gates unmet</Badge>}
      description="Once every quality gate passes, submit the article to a human reviewer. It goes through the Blog pipeline — the generic content route can't skip these gates."
      actions={
        caps.edit ? (
          <Button size="sm" disabled={!p.canSubmitForReview} loading={busy("submit")} onClick={() => run("submit", () => blogApi.submitForReview(workspaceId, itemId))}>
            Submit for review
          </Button>
        ) : undefined
      }
    >
      {!p.canSubmitForReview && gates.length > 0 && (
        <div className={styles.gates}>
          <p className={styles.subhead}>Still needed</p>
          <ul>
            {gates.map((g) => (
              <li key={g}>{REVIEW_GATE_LABEL[g] ?? g}</li>
            ))}
          </ul>
        </div>
      )}
    </StagePanel>
  );
}
