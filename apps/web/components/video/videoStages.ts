import type { VideoListItem, VideoPipeline } from "../../lib/types";
import { VIDEO_GATES, type VideoGateId } from "./videoLabels";

export type GateState = "pending" | "running" | "ready" | "done" | "failed" | "blocked";

/**
 * Per-gate state for the 8-gate stepper. Mirrors the backend's
 * unmetReviewGates / deriveStage ordering so the stepper, the list and
 * the panels always agree. Derived from the read model, never stored.
 */
export function gateStates(p: VideoPipeline): Record<VideoGateId, GateState> {
  const s = p;
  const itemStatus = s.contentItem.status;
  const approved = itemStatus === "APPROVED";
  const inReview = itemStatus === "REVIEW";

  const scriptApproved = s.script.scriptApproved;
  const scriptGate: GateState = scriptApproved
    ? "done"
    : s.brief.status === "FAILED" || s.script.status === "FAILED"
      ? "failed"
      : s.brief.status === "GENERATING" || s.script.status === "GENERATING"
        ? "running"
        : s.script.status === "READY"
          ? "ready"
          : "pending";

  const media = (status: VideoPipeline["assets"]["status"], prereq: boolean): GateState => {
    if (status === "READY") return "done";
    if (status === "FAILED") return "failed";
    if (status === "RUNNING") return "running";
    return prereq ? "pending" : "blocked";
  };

  const qaGate: GateState =
    s.qa.status === "COMPLETED" && s.qa.passed === true
      ? "done"
      : s.qa.status === "COMPLETED"
        ? "failed"
        : s.render.status === "READY"
          ? "pending"
          : "blocked";

  const seoGate: GateState =
    s.seo.seoComplete || s.seo.status === "READY"
      ? "done"
      : s.seo.status === "FAILED"
        ? "failed"
        : s.seo.status === "GENERATING"
          ? "running"
          : "pending";

  const approvalGate: GateState = approved ? "done" : inReview ? "running" : s.canSubmitForReview ? "ready" : "blocked";

  return {
    script_approved: scriptGate,
    assets_available: media(s.assets.status, scriptApproved && s.scenePlan.status === "READY"),
    voice_generated: media(s.voice.status, scriptApproved),
    rendering_successful: media(s.render.status, s.voice.status === "READY" && s.assets.status === "READY"),
    qa_passed: qaGate,
    seo_complete: seoGate,
    human_approval: approvalGate,
    publish_ready: approved ? "done" : "blocked",
  };
}

/** Index of the current gate for <Stepper current={…} /> — the first not-done gate. */
export function currentGateIndex(p: VideoPipeline): number {
  const states = gateStates(p);
  const idx = VIDEO_GATES.findIndex((g) => states[g.id] !== "done");
  return idx === -1 ? VIDEO_GATES.length - 1 : idx;
}

/** Same derivation from the compact list payload (fewer fields available). */
export function deriveListStageLabel(v: VideoListItem): string {
  if (v.status === "APPROVED") return "Publish ready";
  if (v.status === "REVIEW") return "In review";
  if (v.brief !== "READY" && v.brief !== "APPROVED") return "Brief";
  if (v.script !== "APPROVED") return "Script";
  if (v.scenePlan !== "READY") return "Scene plan";
  if (v.render !== "READY") return "Production";
  if (v.seo !== "READY") return "SEO";
  return "Ready for review";
}

/** True while any AI/media stage is genuinely mid-flight — the only time polling is warranted. */
export function isPipelineBusy(p: VideoPipeline): boolean {
  const gen = [p.brief.status, p.script.status, p.scenePlan.status, p.seo.status, p.thumbnailConcepts.status, p.recommendations.status];
  const media = [p.assets.status, p.voice.status, p.subtitles.status, p.thumbnailImage.status, p.render.status];
  return gen.some((s) => s === "GENERATING") || media.some((s) => s === "RUNNING");
}
