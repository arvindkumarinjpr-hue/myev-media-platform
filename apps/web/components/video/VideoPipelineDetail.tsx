"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { videoApi } from "../../lib/api/video";
import { ApiError, friendlyMessage } from "../../lib/errors";
import { hasPermission } from "../../lib/permissions";
import { useSession } from "../../contexts/session-context";
import type { VideoPipeline, VideoScoreFeedback, VideoVoiceProfile } from "../../lib/types";
import { Alert } from "../ui/Alert";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { DescriptionList } from "../ui/DescriptionList";
import { LoadingState } from "../ui/Feedback";
import { Input } from "../ui/Input";
import { Meter } from "../ui/Meter";
import { Stepper } from "../ui/Stepper";
import { Textarea } from "../ui/Textarea";
import { ChevronRightIcon, CheckCircleIcon, XCircleIcon } from "../ui/icons";
import { MediaPreview } from "./MediaPreview";
import {
  AdvisoryStageBadge,
  ContentItemStatusBadge,
  DeterministicStageBadge,
  GenerationStageBadge,
  MediaStageBadge,
  StaleBadge,
} from "./VideoStageBadge";
import { useVideoPipeline } from "./useVideoPipeline";
import { currentGateIndex, gateStates } from "./videoStages";
import {
  PIPELINE_STAGE_LABEL,
  QA_CHECK_LABEL,
  RENDERED_TRANSITIONS,
  REVIEW_GATE_LABEL,
  SCORE_CATEGORY_LABEL,
  TARGET_PLATFORM_LABEL,
  VIDEO_GATES,
  fmtDateTime,
  fmtDuration,
  stageFailureExplanation,
} from "./videoLabels";
import styles from "./VideoPipelineDetail.module.css";

interface Caps {
  view: boolean;
  edit: boolean;
  render: boolean;
  approve: boolean;
  seoEdit: boolean;
  seoScore: boolean;
  mediaView: boolean;
}

export function VideoPipelineDetail({ workspaceId, itemId }: { workspaceId: string; itemId: string }) {
  const { permissions } = useSession();
  const { pipeline, error, applyResult } = useVideoPipeline(workspaceId, itemId);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const run = useCallback(
    async (key: string, runner: () => Promise<VideoPipeline>) => {
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
  if (!pipeline) return <LoadingState label="Loading video pipeline…" />;

  const p = pipeline;
  const caps: Caps = {
    view: hasPermission(permissions, "VIDEO_VIEW"),
    edit: hasPermission(permissions, "VIDEO_EDIT"),
    render: hasPermission(permissions, "VIDEO_RENDER"),
    approve: hasPermission(permissions, "VIDEO_APPROVE"),
    seoEdit: hasPermission(permissions, "SEO_EDIT"),
    seoScore: hasPermission(permissions, "SEO_SCORE"),
    mediaView: hasPermission(permissions, "MEDIA_VIEW"),
  };
  const mutable = p.contentItem.status === "IN_PROGRESS" || p.contentItem.status === "DRAFT";
  const gates = gateStates(p);
  const busy = (k: string) => busyAction === k;
  const ctx: PanelCtx = { workspaceId, itemId, p, caps, run, busy, mutable };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <nav className={styles.breadcrumb} aria-label="Breadcrumb">
          <Link href={`/workspaces/${workspaceId}/video`}>Video</Link>
          <ChevronRightIcon className={styles.sep} aria-hidden="true" />
          <span aria-current="page">{p.contentItem.title || "Video"}</span>
        </nav>
        <div className={styles.headRow}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{p.contentItem.title || "Untitled video"}</h1>
            <div className={styles.metaRow}>
              <ContentItemStatusBadge status={p.contentItem.status} />
              <span className={styles.metaText}>Stage: {PIPELINE_STAGE_LABEL[p.currentStage]}</span>
              {p.videoScript?.targetPlatform && <span className={styles.metaText}>{TARGET_PLATFORM_LABEL[p.videoScript.targetPlatform]}</span>}
              {p.publishReady && <Badge tone="success">Publish ready</Badge>}
            </div>
          </div>
        </div>
      </header>

      <Card className={styles.stepperCard}>
        <Stepper steps={VIDEO_GATES.map((g) => ({ id: g.id, label: g.label }))} current={currentGateIndex(p)} />
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
      {!gates.script_approved && <p className="sr-only">Next: {VIDEO_GATES[currentGateIndex(p)].label}</p>}

      <div className={styles.stages}>
        <BriefPanel {...ctx} />
        <ScriptPanel {...ctx} />
        <ScenePlanPanel {...ctx} />
        <AssetsPanel {...ctx} />
        <VoicePanel {...ctx} />
        <SubtitlesPanel {...ctx} />
        <ThumbnailPanel {...ctx} />
        <SeoPanel {...ctx} />
        <RecommendationsPanel {...ctx} />
        <RenderPanel {...ctx} />
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
  p: VideoPipeline;
  caps: Caps;
  run: (key: string, runner: () => Promise<VideoPipeline>) => Promise<void>;
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

function FailureNote({ reason }: { reason: string | null | undefined }) {
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

// --- Brief ---------------------------------------------------------------

function BriefPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.brief;
  const a = s.artifact;
  return (
    <StagePanel
      title="Brief"
      badge={<GenerationStageBadge status={s.status} />}
      description="Objective, audience, platform, target duration and the CTA."
      actions={
        caps.edit && mutable ? (
          <>
            {(s.status === "PENDING" || s.status === "FAILED") && (
              <Button size="sm" loading={busy("brief.gen")} onClick={() => run("brief.gen", () => videoApi.generateBrief(workspaceId, itemId))}>
                {s.status === "FAILED" ? "Regenerate brief" : "Generate brief"}
              </Button>
            )}
            {(s.status === "READY" || s.status === "APPROVED") && (
              <Button size="sm" variant="secondary" loading={busy("brief.regen")} onClick={() => run("brief.regen", () => videoApi.generateBrief(workspaceId, itemId))}>
                Regenerate
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
              { term: "Objective", value: a.objective },
              { term: "Audience", value: a.audience },
              { term: "Platform", value: <Badge tone="info">{a.targetPlatform}</Badge> },
              { term: "Duration", value: `${a.durationSeconds}s` },
              { term: "CTA", value: a.cta },
            ]}
          />
          {a.rationale && <p className={styles.rationale}>{a.rationale}</p>}
        </>
      )}
      <p className={styles.note}>Regenerating the brief resets the script, scene plan and every downstream stage.</p>
    </StagePanel>
  );
}

// --- Script -------------------------------------------------------------

function ScriptPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.script;
  const a = s.artifact;
  const prereqMet = p.brief.status === "READY" || p.brief.status === "APPROVED";
  return (
    <StagePanel
      title="Script"
      badge={s.scriptApproved ? <Badge tone="success">Approved</Badge> : <GenerationStageBadge status={s.status} />}
      description="Hook, ordered narration segments and the spoken CTA. Approving it is Quality Gate #1 — nothing downstream runs until it is."
      actions={
        caps.edit && mutable ? (
          <>
            {prereqMet && (s.status === "PENDING" || s.status === "FAILED") && (
              <Button size="sm" loading={busy("script.gen")} onClick={() => run("script.gen", () => videoApi.generateScript(workspaceId, itemId))}>
                {s.status === "FAILED" ? "Regenerate script" : "Generate script"}
              </Button>
            )}
            {(s.status === "READY" || s.status === "APPROVED") && (
              <Button size="sm" variant="secondary" loading={busy("script.regen")} onClick={() => run("script.regen", () => videoApi.generateScript(workspaceId, itemId))}>
                Regenerate
              </Button>
            )}
            {s.status === "READY" && !s.scriptApproved && (
              <Button size="sm" loading={busy("script.approve")} onClick={() => run("script.approve", () => videoApi.approveScript(workspaceId, itemId))}>
                Approve script (Gate #1)
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Generate the brief first — the script is written from it.</p>}
      {s.status === "GENERATING" && <GeneratingNote label="Writing the script" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {s.scriptApproved && s.approvedAt && <p className={styles.note}>Approved {fmtDateTime(s.approvedAt)}. Regenerating the script clears this approval and every downstream stage.</p>}
      {a && (
        <article className={styles.reader}>
          <p className={styles.readerCta}>{a.hook}</p>
          {[...a.segments]
            .sort((x, y) => x.order - y.order)
            .map((seg) => (
              <section key={seg.id}>
                <h3 className={styles.readerHeading}>
                  {seg.order}. {seg.label} <span className={styles.muted}>· {seg.purpose}</span>
                </h3>
                <p>{seg.narration}</p>
              </section>
            ))}
          <p className={styles.readerCta}>{a.cta}</p>
        </article>
      )}
    </StagePanel>
  );
}

// --- Scene plan -------------------------------------------------------

function ScenePlanPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.scenePlan;
  const a = s.artifact;
  const prereqMet = p.script.scriptApproved;
  return (
    <StagePanel
      title="Scene plan"
      badge={<GenerationStageBadge status={s.status} />}
      description="Ordered scenes mapped to script segments — visual instruction, B-roll idea, transition and the asset each scene needs."
      actions={
        caps.edit && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={s.status === "READY" ? "secondary" : "primary"}
            loading={busy("scene.gen")}
            onClick={() => run("scene.gen", () => videoApi.generateScenePlan(workspaceId, itemId))}
          >
            {s.status === "READY" ? "Regenerate scene plan" : s.status === "FAILED" ? "Regenerate scene plan" : "Generate scene plan"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Approve the script first (Gate #1).</p>}
      {s.status === "GENERATING" && <GeneratingNote label="Planning the scenes" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {a && (
        <ol className={styles.sectionList}>
          {[...a.scenes]
            .sort((x, y) => x.order - y.order)
            .map((sc) => (
              <li key={sc.sceneId} className={styles.section}>
                <span className={styles.sectionHeading}>
                  <Badge tone="neutral">{sc.sceneId}</Badge>
                  {sc.visualInstruction}
                  <Badge tone={RENDERED_TRANSITIONS.includes(sc.transition as (typeof RENDERED_TRANSITIONS)[number]) ? "info" : "neutral"}>{sc.transition}</Badge>
                </span>
                <span className={styles.sectionPurpose}>
                  {sc.startSeconds}s–{(sc.startSeconds + sc.durationSeconds).toFixed(1)}s · segment {sc.scriptSegmentRef}
                  {sc.bRollSuggestion ? ` · B-roll: ${sc.bRollSuggestion}` : ""}
                </span>
              </li>
            ))}
        </ol>
      )}
      {a && a.scenes.some((sc) => !RENDERED_TRANSITIONS.includes(sc.transition as (typeof RENDERED_TRANSITIONS)[number])) && (
        <p className={styles.note}>Only cut, fade and dissolve are rendered today — other transitions play as a hard cut.</p>
      )}
    </StagePanel>
  );
}

// --- Assets (Gate #2) ------------------------------------------------

function AssetsPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.assets;
  const plan = p.scenePlan.artifact;
  const prereqMet = p.script.scriptApproved && p.scenePlan.status === "READY";
  const [attachFor, setAttachFor] = useState<string | null>(null);
  const [assetId, setAssetId] = useState("");

  const titleFor = (sceneId: string) => plan?.scenes.find((sc) => sc.sceneId === sceneId)?.visualInstruction ?? sceneId;

  return (
    <StagePanel
      title="Assets"
      badge={<MediaStageBadge status={s.status} />}
      description="Every scene needs a resolved, verified image. Generate one with AI, or attach an existing workspace asset by its id. Quality Gate #2 itemizes any scene still missing an asset."
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Approve the script and generate a scene plan first.</p>}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {s.missingScenes.length > 0 && (
        <Alert tone="warning" role="status" className={styles.failure}>
          Missing an asset for: {s.missingScenes.join(", ")}
        </Alert>
      )}
      {prereqMet && s.scenes.length > 0 && (
        <div className={styles.sceneGrid}>
          {s.scenes.map((sc) => (
            <div key={sc.sceneId} className={styles.scene}>
              <div className={styles.sceneHead}>
                <span className={styles.sceneTitle}>{sc.sceneId}</span>
                {sc.mediaAssetPublicId ? <Badge tone="success">{sc.source ?? "resolved"}</Badge> : sc.mediaJobPublicId ? <Badge tone="warning" dot>Generating</Badge> : <Badge tone="neutral">Unresolved</Badge>}
              </div>
              <span className={styles.sceneMeta}>{titleFor(sc.sceneId)}</span>
              {sc.failureReason && <FailureNote reason={sc.failureReason} />}
              {sc.mediaAssetPublicId && caps.mediaView && (
                <MediaPreview workspaceId={workspaceId} assetPublicId={sc.mediaAssetPublicId} kind="image" alt={`Scene ${sc.sceneId} image`} />
              )}
              {caps.edit && mutable && (
                <div className={styles.sceneActions}>
                  <Button
                    size="sm"
                    variant={sc.mediaAssetPublicId ? "secondary" : "primary"}
                    loading={busy(`asset.gen.${sc.sceneId}`)}
                    onClick={() => run(`asset.gen.${sc.sceneId}`, () => videoApi.generateSceneImage(workspaceId, itemId, sc.sceneId))}
                  >
                    {sc.mediaAssetPublicId ? "Regenerate image" : "Generate image"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAttachFor(attachFor === sc.sceneId ? null : sc.sceneId)}>
                    Attach existing
                  </Button>
                </div>
              )}
              {attachFor === sc.sceneId && caps.edit && mutable && (
                <div className={styles.attachRow}>
                  <Input
                    value={assetId}
                    placeholder="MediaAsset public id"
                    aria-label={`Existing asset id for ${sc.sceneId}`}
                    onChange={(e) => setAssetId(e.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={!assetId.trim()}
                    loading={busy(`asset.attach.${sc.sceneId}`)}
                    onClick={() =>
                      run(`asset.attach.${sc.sceneId}`, async () => {
                        const next = await videoApi.attachSceneAsset(workspaceId, itemId, sc.sceneId, assetId.trim());
                        setAttachFor(null);
                        setAssetId("");
                        return next;
                      })
                    }
                  >
                    Attach
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <p className={styles.note}>Stock / B-roll provider sourcing is a later enhancement — attach or generate per scene here.</p>
    </StagePanel>
  );
}

// --- Voice (Gate #3) -----------------------------------------------

function VoicePanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.voice;
  const prereqMet = p.script.scriptApproved;
  const stale = /script changed since voice/i.test(s.failureReason ?? "");
  const [catalog, setCatalog] = useState<VideoVoiceProfile[] | null>(null);
  const [selected, setSelected] = useState<string>("");

  useEffect(() => {
    if (!caps.view) return;
    let cancelled = false;
    videoApi
      .voice(workspaceId, itemId)
      .then((v) => {
        if (cancelled) return;
        setCatalog(v.voiceCatalog);
        setSelected((cur) => cur || v.voice.voiceProfileId || v.voiceCatalog[0]?.voiceProfileId || "");
      })
      .catch(() => {
        if (!cancelled) setCatalog([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, itemId, caps.view, s.voiceProfileId]);

  return (
    <StagePanel
      title="Voice"
      badge={stale ? <StaleBadge /> : <MediaStageBadge status={s.status} />}
      description="Narration generated from the approved script. Quality Gate #3 needs a real, verified audio asset whose script hash still matches."
      actions={
        caps.edit && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={s.status === "READY" ? "secondary" : "primary"}
            disabled={!selected}
            loading={busy("voice.gen")}
            onClick={() => run("voice.gen", () => videoApi.generateVoice(workspaceId, itemId, selected))}
          >
            {s.status === "READY" ? "Regenerate voice" : s.status === "RUNNING" ? "Regenerate voice" : "Generate voice"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && <p className={styles.prereq}>Approve the script first (Gate #1).</p>}
      {s.status === "RUNNING" && <GeneratingNote label="Generating the narration" />}
      {s.status === "FAILED" && !stale && <FailureNote reason={s.failureReason} />}
      {stale && (
        <Alert tone="warning" role="status" className={styles.failure}>
          {stageFailureExplanation(s.failureReason)}
        </Alert>
      )}
      {prereqMet && catalog && catalog.length > 0 && caps.edit && mutable && (
        <fieldset className={styles.voiceGrid}>
          <legend className="sr-only">Voice profile</legend>
          {catalog.map((v) => (
            <label key={v.voiceProfileId} className={styles.voiceOption} data-selected={selected === v.voiceProfileId}>
              <input type="radio" name="voice-profile" value={v.voiceProfileId} checked={selected === v.voiceProfileId} onChange={() => setSelected(v.voiceProfileId)} />
              <strong>{v.displayName}</strong>
              <span className={styles.conceptField}>{v.language}</span>
            </label>
          ))}
        </fieldset>
      )}
      {s.status === "READY" && (
        <>
          <p className={styles.note}>
            {s.voiceProfileId} · {fmtDuration(s.audioDurationMs)}
          </p>
          {s.audioAssetPublicId && caps.mediaView && (
            <MediaPreview workspaceId={workspaceId} assetPublicId={s.audioAssetPublicId} kind="audio" alt="Narration audio" />
          )}
        </>
      )}
    </StagePanel>
  );
}

// --- Subtitles ------------------------------------------------------

function SubtitlesPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.subtitles;
  const stale = /voice was regenerated|rebuild subtitles|voice regenerating/i.test(s.failureReason ?? "");
  const prereqMet = p.voice.status === "READY";
  return (
    <StagePanel
      title="Subtitles"
      badge={stale ? <StaleBadge /> : <MediaStageBadge status={s.status} />}
      description="Timing-aligned captions (SRT + VTT) built against the current narration audio. Regenerating the voice marks these stale."
      actions={
        caps.edit && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={s.status === "READY" ? "secondary" : "primary"}
            loading={busy("subs.gen")}
            onClick={() => run("subs.gen", () => videoApi.generateSubtitles(workspaceId, itemId))}
          >
            {s.status === "READY" ? "Rebuild subtitles" : "Generate subtitles"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && <p className={styles.prereq}>Generate the narration first (Gate #3).</p>}
      {s.status === "RUNNING" && <GeneratingNote label="Aligning the captions" />}
      {s.status === "FAILED" && !stale && <FailureNote reason={s.failureReason} />}
      {stale && (
        <Alert tone="warning" role="status" className={styles.failure}>
          {stageFailureExplanation(s.failureReason)}
        </Alert>
      )}
      {s.status === "READY" && <p className={styles.note}>{s.cueCount ?? "—"} cues · SRT + VTT generated</p>}
    </StagePanel>
  );
}

// --- Thumbnail ----------------------------------------------------

function ThumbnailPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const concepts = p.thumbnailConcepts;
  const img = p.thumbnailImage;
  const list = concepts.artifact?.concepts ?? [];
  const prereqMet = p.script.status === "READY" || p.script.scriptApproved;
  return (
    <StagePanel
      title="Thumbnail"
      badge={img.status === "READY" ? <Badge tone="success">Ready</Badge> : <AdvisoryStageBadge status={concepts.status} />}
      description="Advisory: generate concept options, pick one, then render a real thumbnail image. The Thumbnail Score reads from the selected concept."
      actions={
        caps.edit && mutable && prereqMet ? (
          <>
            <Button
              size="sm"
              variant={list.length ? "secondary" : "primary"}
              loading={busy("tc.gen")}
              onClick={() => run("tc.gen", () => videoApi.generateThumbnailConcepts(workspaceId, itemId))}
            >
              {list.length ? "Regenerate concepts" : "Generate concepts"}
            </Button>
            {img.selectedConceptIndex !== null && (
              <Button
                size="sm"
                loading={busy("ti.gen")}
                onClick={() => run("ti.gen", () => videoApi.generateThumbnailImage(workspaceId, itemId))}
              >
                {img.status === "READY" ? "Regenerate image" : "Generate image"}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {concepts.status === "GENERATING" && <GeneratingNote label="Generating thumbnail concepts" />}
      {concepts.status === "FAILED" && <FailureNote reason={concepts.failureReason} />}
      {img.status === "RUNNING" && <GeneratingNote label="Rendering the thumbnail image" />}
      {img.status === "FAILED" && <FailureNote reason={img.failureReason} />}
      {img.status === "READY" && img.imageAssetPublicId && caps.mediaView && (
        <MediaPreview workspaceId={workspaceId} assetPublicId={img.imageAssetPublicId} kind="image" alt="Thumbnail image" />
      )}
      {list.length > 0 && (
        <div className={styles.conceptGrid}>
          {list.map((c, i) => (
            <div key={i} className={styles.concept} data-selected={img.selectedConceptIndex === i}>
              <span className={styles.conceptTitle}>
                {c.title} {img.selectedConceptIndex === i && <Badge tone="info">Selected</Badge>}
              </span>
              <span className={styles.overlayText}>“{c.overlayText}”</span>
              <span className={styles.conceptField}>{c.visualDirection}</span>
              <span className={styles.conceptField}>{c.composition}</span>
              <span className={styles.conceptField}>{c.ctrHypothesis}</span>
              {caps.edit && mutable && img.selectedConceptIndex !== i && (
                <Button size="sm" variant="ghost" loading={busy(`tc.sel.${i}`)} onClick={() => run(`tc.sel.${i}`, () => videoApi.selectThumbnailConcept(workspaceId, itemId, i))}>
                  Select this concept
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </StagePanel>
  );
}

// --- SEO (Gate #6) --------------------------------------------------

function SeoPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.seo;
  const a = s.artifact;
  const prereqMet = p.script.scriptApproved;
  const [showSchema, setShowSchema] = useState(false);
  return (
    <StagePanel
      title="SEO"
      badge={s.seoComplete ? <Badge tone="success">Complete</Badge> : <GenerationStageBadge status={s.status} />}
      description="Meta title, description, tags, chapters, hashtags and a schema.org VideoObject suggestion. Requires SEO_EDIT — read-only otherwise."
      actions={
        caps.seoEdit && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={s.status === "READY" ? "secondary" : "primary"}
            loading={busy("seo.gen")}
            onClick={() => run("seo.gen", () => videoApi.generateSeo(workspaceId, itemId))}
          >
            {s.status === "READY" ? "Regenerate SEO" : s.status === "FAILED" ? "Regenerate SEO" : "Generate SEO"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Approve the script first (Gate #1).</p>}
      {!caps.seoEdit && <p className={styles.prereq}>You can view the SEO metadata but not edit or regenerate it (needs SEO_EDIT).</p>}
      {s.status === "GENERATING" && <GeneratingNote label="Generating SEO metadata" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {a && (
        <>
          <DescriptionList
            className={styles.dl}
            items={[
              { term: "Meta title", value: a.metaTitle },
              { term: "Meta description", value: a.metaDescription },
              {
                term: "Tags",
                value: a.tags.length ? <span className={styles.seoTags}>{a.tags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</span> : "—",
              },
              {
                term: "Hashtags",
                value: a.hashtags.length ? <span className={styles.seoTags}>{a.hashtags.map((t) => <Badge key={t} tone="neutral">{t}</Badge>)}</span> : "—",
              },
              {
                term: "Chapters",
                value: a.chapters.length ? (
                  <ul className={styles.renderHistory}>
                    {a.chapters.map((c, i) => (
                      <li key={i}>
                        {c.startSeconds}s — {c.title}
                      </li>
                    ))}
                  </ul>
                ) : (
                  "—"
                ),
              },
            ]}
          />
          <button type="button" className={styles.disclosure} aria-expanded={showSchema} onClick={() => setShowSchema((v) => !v)}>
            {showSchema ? "Hide" : "Show"} schema.org markup
          </button>
          {showSchema && <pre className={styles.schema}>{JSON.stringify(a.schemaMarkup, null, 2)}</pre>}
        </>
      )}
    </StagePanel>
  );
}

// --- Recommendations (advisory) -----------------------------------

function RecommendationsPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.recommendations;
  const list = s.artifact?.recommendations ?? [];
  const prereqMet = p.script.status === "READY" || p.script.scriptApproved;
  return (
    <StagePanel
      title="AI recommendations"
      badge={<AdvisoryStageBadge status={s.status} />}
      description="Advisory ideas — better hook, thumbnail, title, shorter intro, stronger CTA, repurpose opportunities. Never gates review."
      actions={
        caps.edit && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={list.length ? "secondary" : "primary"}
            loading={busy("rec.gen")}
            onClick={() => run("rec.gen", () => videoApi.generateRecommendations(workspaceId, itemId))}
          >
            {list.length ? "Regenerate" : "Generate recommendations"}
          </Button>
        ) : undefined
      }
    >
      {s.status === "GENERATING" && <GeneratingNote label="Generating recommendations" />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      {list.length > 0 && (
        <ul className={styles.recList}>
          {list.map((r, i) => (
            <li key={i} className={styles.recItem}>
              <strong>{r.kind.replace(/_/g, " ")}:</strong> {r.suggestion}
              <span className={styles.factorReason}> — {r.rationale}</span>
            </li>
          ))}
        </ul>
      )}
    </StagePanel>
  );
}

// --- Render (Gate #4) + preview ----------------------------------

function RenderPanel({ workspaceId, itemId, p, caps, run, busy }: PanelCtx) {
  const s = p.render;
  const prereqMet = p.voice.status === "READY" && p.subtitles.status === "READY" && p.assets.status === "READY";
  const running = s.status === "RUNNING";
  const canRender = caps.render && (p.contentItem.status === "IN_PROGRESS" || p.contentItem.status === "DRAFT");
  return (
    <StagePanel
      title="Render"
      badge={<MediaStageBadge status={s.status} />}
      description="Renders the final video via the Remotion/FFmpeg pipeline with the watermark applied. Quality Gate #4 needs a verified, geometry-matched output video. Triggering a render needs VIDEO_RENDER."
      actions={
        canRender ? (
          <Button
            size="sm"
            variant={s.status === "READY" ? "secondary" : "primary"}
            disabled={!prereqMet || running}
            loading={busy("render.submit")}
            onClick={() => run("render.submit", () => videoApi.submitRender(workspaceId, itemId))}
          >
            {s.status === "READY" ? "Re-render" : running ? "Rendering…" : s.status === "FAILED" ? "Retry render" : "Submit render"}
          </Button>
        ) : undefined
      }
    >
      {!caps.render && <p className={styles.prereq}>Rendering is done by a Video Editor or an Administrator (needs VIDEO_RENDER).</p>}
      {!prereqMet && s.status !== "READY" && <p className={styles.prereq}>Assets, voice and subtitles must all be ready before a render.</p>}
      {running && <GeneratingNote label={`Rendering (attempt ${s.attempt || 1})`} />}
      {s.status === "FAILED" && <FailureNote reason={s.failureReason} />}
      <div className={styles.renderMeta}>
        {s.exportProfileId && <span>Export profile: {s.exportProfileId}</span>}
        {p.videoScript?.exportProfile && !s.exportProfileId && <span>Export profile: {p.videoScript.exportProfile}</span>}
        {s.outputWidth && (
          <span>
            {s.outputWidth}×{s.outputHeight} · {fmtDuration(s.outputDurationMs)}
          </span>
        )}
        {s.completedAt && <span>Rendered {fmtDateTime(s.completedAt)}</span>}
      </div>
      {s.status === "READY" && s.renderedVideoPublicId && caps.mediaView && (
        <MediaPreview workspaceId={workspaceId} assetPublicId={s.renderedVideoPublicId} kind="video" alt="Rendered video" />
      )}
      {s.status === "READY" && s.renderedVideoPublicId && !caps.mediaView && (
        <p className={styles.prereq}>The render is complete. You need MEDIA_VIEW to preview the video here.</p>
      )}
    </StagePanel>
  );
}

// --- QA (Gate #5) ------------------------------------------------

function QaPanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.qa;
  const prereqMet = p.render.status === "READY";
  return (
    <StagePanel
      title="Quality assurance"
      badge={
        s.status === "COMPLETED" && s.passed !== null ? (
          <Badge tone={s.passed ? "success" : "danger"}>{s.passed ? "Passed" : "Failed"}</Badge>
        ) : (
          <DeterministicStageBadge status={s.status} />
        )
      }
      description="Six deterministic checks against the produced file: missing assets, audio sync, subtitle sync, resolution, duration, branding. All six pass = Quality Gate #5."
      actions={
        caps.edit && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={s.status === "COMPLETED" ? "secondary" : "primary"}
            loading={busy("qa.run")}
            onClick={() => run("qa.run", () => videoApi.runQa(workspaceId, itemId))}
          >
            {s.status === "COMPLETED" ? "Re-run QA" : "Run QA"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>A current, successful render is required before QA.</p>}
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
                {(c.measured != null || c.expected != null) && (
                  <p className={styles.qaExplain}>
                    Measured {String(c.measured ?? "—")} · expected {String(c.expected ?? "—")}
                  </p>
                )}
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
      <p className={styles.note}>QA is computed server-side against the real file — the browser never infers a visual result.</p>
    </StagePanel>
  );
}

// --- Score -------------------------------------------------------

function ScorePanel({ workspaceId, itemId, p, caps, run, busy, mutable }: PanelCtx) {
  const s = p.score;
  const prereqMet = p.qa.status === "COMPLETED" && p.seo.status === "READY";
  const [feedback, setFeedback] = useState<VideoScoreFeedback | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    if (!caps.view) return;
    let cancelled = false;
    videoApi
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
  }, [workspaceId, itemId, caps.view, s.contentScorePublicId]);

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
      description="The shared scoring engine: an overall 0–100 plus the five universal categories, the Video Score and the Thumbnail Score. The video must reach the pass threshold before review. Running the score needs SEO_SCORE."
      actions={
        caps.seoScore && mutable && prereqMet ? (
          <Button
            size="sm"
            variant={s.status === "COMPLETED" ? "secondary" : "primary"}
            loading={busy("score.run")}
            onClick={() => run("score.run", () => videoApi.runScore(workspaceId, itemId))}
          >
            {s.status === "COMPLETED" ? "Re-score" : "Run content score"}
          </Button>
        ) : undefined
      }
    >
      {!prereqMet && s.status === "PENDING" && <p className={styles.prereq}>Pass QA and complete the SEO stage first.</p>}
      {!caps.seoScore && caps.view && s.status !== "COMPLETED" && <p className={styles.prereq}>You can view the score once it is run (running it needs SEO_SCORE).</p>}
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
            {s.passed ? "This video passes." : "This video is below the threshold and cannot go to review yet."}
          </p>
        </div>
      )}

      {feedback && (
        <>
          <div className={styles.categoryGrid}>
            {Object.keys(feedback.categoryScores).map((cat) => (
              <div key={cat} className={styles.category}>
                <span className={styles.categoryName}>{SCORE_CATEGORY_LABEL[cat] ?? cat}</span>
                <Meter value={feedback.categoryScores[cat]} label={`${SCORE_CATEGORY_LABEL[cat] ?? cat} score`} />
              </div>
            ))}
            <div className={styles.category}>
              <span className={styles.categoryName}>{feedback.videoScore.label || "Video"} dimension</span>
              <Meter value={feedback.videoScore.score} label="Video dimension score" tone="neutral" />
            </div>
            {feedback.thumbnailScore && (
              <div className={styles.category}>
                <span className={styles.categoryName}>{feedback.thumbnailScore.label || "Thumbnail"} dimension</span>
                <Meter value={feedback.thumbnailScore.score} label="Thumbnail dimension score" tone="neutral" />
              </div>
            )}
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
        </>
      )}
    </StagePanel>
  );
}

// --- Review -----------------------------------------------------

function ReviewPanel({ workspaceId, itemId, p, caps, run, busy }: PanelCtx) {
  const [comment, setComment] = useState("");
  const status = p.contentItem.status;

  if (status === "APPROVED") {
    return (
      <StagePanel title="Review & publish" badge={<Badge tone="success">Approved</Badge>}>
        <Alert tone="success" role="status" className={styles.failure}>
          This video is approved and <strong>publish ready</strong> (Gate #8). Publishing to YouTube and other channels is delivered by a later module.
        </Alert>
      </StagePanel>
    );
  }

  if (status === "REVIEW") {
    return (
      <StagePanel
        title="Human approval"
        badge={<Badge tone="warning" dot>In review</Badge>}
        description="A reviewer with approval authority (Gate #7) decides whether this video goes forward. Human approval is always required."
      >
        {caps.approve ? (
          <div className={styles.reviewForm}>
            <label htmlFor="review-comment" className={styles.subhead}>
              Comment <span className={styles.muted}>(required to reject)</span>
            </label>
            <Textarea id="review-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Optional for approve, required for reject" />
            <div className={styles.panelActions}>
              <Button size="sm" loading={busy("approve")} onClick={() => run("approve", () => videoApi.approve(workspaceId, itemId, comment.trim() || undefined))}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={!comment.trim()}
                loading={busy("reject")}
                onClick={() => run("reject", () => videoApi.reject(workspaceId, itemId, comment.trim()))}
              >
                Reject
              </Button>
            </div>
          </div>
        ) : (
          <p className={styles.prereq}>This video is awaiting review by someone with VIDEO_APPROVE.</p>
        )}
      </StagePanel>
    );
  }

  const gates = p.reviewGatesUnmet;
  return (
    <StagePanel
      title="Submit for review"
      badge={p.canSubmitForReview ? <Badge tone="success">Ready</Badge> : <Badge tone="neutral">Gates unmet</Badge>}
      description="Once every quality gate passes, submit the video to a human reviewer. It goes through the Video pipeline — the generic content route can't skip these gates."
      actions={
        caps.edit ? (
          <Button size="sm" disabled={!p.canSubmitForReview} loading={busy("submit")} onClick={() => run("submit", () => videoApi.submitForReview(workspaceId, itemId))}>
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
