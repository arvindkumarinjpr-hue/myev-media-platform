/**
 * Module 7 Phase 7.5 — deterministic scene-timing derivation
 * (checkpoint §6 / FR-VID-003).
 *
 * Pure logic, no I/O. Turns the current ScenePlan + current approved
 * Script + current Voice audio duration into an ordered, absolute
 * millisecond timeline the renderer consumes. The narration audio
 * duration is the PRIMARY authority for total length where narration
 * exists — the ScenePlan's own `durationSeconds` values are treated as
 * relative weights and rescaled to fit the real audio, so the rendered
 * video never drifts from the voice track.
 *
 * Rejects (never silently guesses):
 *  - a scene with a non-positive duration
 *  - overlapping or out-of-order scenes
 *  - a scene whose `scriptSegmentRef` is not a current script segment id
 *  - a scene with no resolved asset (when `resolvedSceneIds` is supplied)
 *  - a plan whose scene id set differs from the supplied current set
 */

export interface SceneTimelineEntry {
  readonly sceneId: string;
  readonly order: number;
  readonly startMs: number;
  readonly durationMs: number;
  readonly scriptSegmentId: string;
  readonly transition: string;
}

export interface SceneTimelineInputScene {
  readonly sceneId: string;
  readonly order: number;
  readonly durationSeconds: number;
  readonly scriptSegmentRef: string;
  readonly transition: string;
}

export interface DeriveSceneTimelineOptions {
  /** Authoritative narration length in ms. When > 0 the timeline is scaled to it. */
  readonly voiceDurationMs: number;
  /** Current approved-script segment ids — every scene must reference one. */
  readonly scriptSegmentIds: readonly string[];
  /** Current ScenePlan scene ids, in order — the plan must match this exactly. */
  readonly currentSceneIds: readonly string[];
  /** Scene ids that have a resolved ACTIVE asset. When provided, every scene must be present. */
  readonly resolvedSceneIds?: readonly string[];
  /** Max acceptable drift between summed scene durations and the audio (ms). */
  readonly toleranceMs?: number;
}

export interface SceneTimelineResult {
  readonly ok: boolean;
  readonly errors: string[];
  readonly timeline: SceneTimelineEntry[];
  /** Sum of scene durations — equals `voiceDurationMs` (within rounding) when scaled. */
  readonly totalDurationMs: number;
}

const DEFAULT_TOLERANCE_MS = 400;

export function deriveSceneTimeline(scenes: readonly SceneTimelineInputScene[], options: DeriveSceneTimelineOptions): SceneTimelineResult {
  const errors: string[] = [];
  const tolerance = options.toleranceMs ?? DEFAULT_TOLERANCE_MS;

  const ordered = [...scenes].sort((a, b) => a.order - b.order);

  if (ordered.length === 0) {
    return { ok: false, errors: ["scene plan has no scenes"], timeline: [], totalDurationMs: 0 };
  }

  // Scene id set must match the supplied current ScenePlan exactly.
  const planIds = ordered.map((s) => s.sceneId).join(",");
  const currentIds = [...options.currentSceneIds].join(",");
  if (planIds !== currentIds) {
    errors.push(`scene plan scenes [${planIds}] do not match the current scene set [${currentIds}] — the plan is stale`);
  }

  // Contiguous 1..N order.
  for (let i = 0; i < ordered.length; i++) {
    if (ordered[i].order !== i + 1) {
      errors.push(`scene "${ordered[i].sceneId}" has order ${ordered[i].order}, expected ${i + 1} (scenes must be a contiguous 1..N)`);
    }
  }

  const segmentSet = new Set(options.scriptSegmentIds);
  for (const s of ordered) {
    if (!segmentSet.has(s.scriptSegmentRef)) {
      errors.push(`scene "${s.sceneId}" references script segment "${s.scriptSegmentRef}" which is not in the current approved script`);
    }
    if (!(s.durationSeconds > 0)) {
      errors.push(`scene "${s.sceneId}" has a non-positive durationSeconds (${s.durationSeconds})`);
    }
  }

  if (options.resolvedSceneIds) {
    const resolved = new Set(options.resolvedSceneIds);
    for (const s of ordered) {
      if (!resolved.has(s.sceneId)) errors.push(`scene "${s.sceneId}" has no resolved ACTIVE asset`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, timeline: [], totalDurationMs: 0 };
  }

  const rawTotalMs = ordered.reduce((sum, s) => sum + Math.round(s.durationSeconds * 1000), 0);
  const useVoice = options.voiceDurationMs > 0;
  const targetTotalMs = useVoice ? Math.round(options.voiceDurationMs) : rawTotalMs;

  // Rescale each scene proportionally so the summed timeline equals the
  // authoritative audio length exactly (last scene absorbs rounding).
  const scale = useVoice && rawTotalMs > 0 ? targetTotalMs / rawTotalMs : 1;
  const timeline: SceneTimelineEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < ordered.length; i++) {
    const s = ordered[i];
    const isLast = i === ordered.length - 1;
    const durationMs = isLast ? targetTotalMs - cursor : Math.max(1, Math.round(Math.round(s.durationSeconds * 1000) * scale));
    if (durationMs <= 0) {
      return { ok: false, errors: [`scene "${s.sceneId}" scaled to a non-positive duration (${durationMs}ms)`], timeline: [], totalDurationMs: 0 };
    }
    timeline.push({ sceneId: s.sceneId, order: s.order, startMs: cursor, durationMs, scriptSegmentId: s.scriptSegmentRef, transition: s.transition });
    cursor += durationMs;
  }

  // Overlap / monotonic guard (defensive — construction is sequential).
  for (let i = 1; i < timeline.length; i++) {
    if (timeline[i].startMs !== timeline[i - 1].startMs + timeline[i - 1].durationMs) {
      return { ok: false, errors: [`scene "${timeline[i].sceneId}" is not contiguous with the previous scene`], timeline: [], totalDurationMs: 0 };
    }
  }

  const total = cursor;
  if (useVoice && Math.abs(total - targetTotalMs) > tolerance) {
    errors.push(`derived timeline (${total}ms) drifts from the narration audio (${targetTotalMs}ms) beyond ${tolerance}ms`);
  }

  return { ok: errors.length === 0, errors, timeline, totalDurationMs: total };
}
