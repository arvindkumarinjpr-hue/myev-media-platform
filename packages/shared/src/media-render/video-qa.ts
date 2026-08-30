/**
 * Module 7 Phase 7.5 — the Video QA Engine
 * (VIDEO_AUTOMATION_ENGINE_V1.0.md §8, FR-VID-008). The frozen six
 * checks, each a pure function over genuine persisted artifacts + real
 * render-output inspection. No perceptual analysis, no OCR, no CV — every
 * PASS/FAIL is something the renderer and the container can prove
 * deterministically. Gate #5 requires all six PASS
 * (checkpoint §15/§23).
 */

export const QA_CHECK_IDS = ["missing_assets", "audio_sync", "subtitle_sync", "resolution", "duration", "branding"] as const;
export type QaCheckId = (typeof QA_CHECK_IDS)[number];

export interface QaCheckResult {
  readonly id: QaCheckId;
  readonly label: string;
  readonly passed: boolean;
  /** Safe, human-readable one-liner. Never a stack trace or raw provider text. */
  readonly explanation: string;
  /** Structured evidence lines. */
  readonly evidence: string[];
  /** Measured value (as inspected), when the check has one. */
  readonly measured?: number | string | null;
  /** Expected value / bound, when the check has one. */
  readonly expected?: number | string | null;
}

export interface QaReport {
  readonly checks: QaCheckResult[];
  readonly passed: boolean;
  readonly generatedAt: string;
}

export interface QaSubtitleCue {
  readonly startMs: number;
  readonly endMs: number;
}

export interface VideoQaInput {
  /** Expected output geometry + fps for the render's target platform. */
  readonly expectedWidth: number;
  readonly expectedHeight: number;
  readonly expectedProfileId: string;
  /** Duration the deterministic timeline / narration says the video should be. */
  readonly expectedDurationMs: number;

  /** From `parseMp4` of the persisted VIDEO MediaAsset + its row. */
  readonly output: {
    readonly width: number | null;
    readonly height: number | null;
    readonly durationMs: number | null;
    readonly hasAudioTrack: boolean;
    readonly byteLength: number;
    readonly containerOk: boolean;
  };

  /** The render input snapshot's per-scene asset resolution (checkpoint §16). */
  readonly snapshotScenes: ReadonlyArray<{ sceneId: string; assetResolved: boolean; materialized: boolean }>;

  /** Authoritative narration artifact (Gate #3). */
  readonly voice: {
    readonly durationMs: number;
    readonly wordTimingCount: number;
    readonly audioAssetPublicId: string | null;
  };

  /** Current subtitle artifact (Phase 7.4). */
  readonly subtitles: {
    readonly cues: readonly QaSubtitleCue[];
    readonly sourceAudioAssetPublicId: string | null;
  };

  /** Deterministic branding evidence the renderer recorded (checkpoint §21). */
  readonly branding: {
    readonly layerConfigured: boolean;
    readonly logoAssetInSnapshot: boolean;
    readonly introRequired: boolean;
    readonly introRendered: boolean;
    readonly outroRequired: boolean;
    readonly outroRendered: boolean;
  };

  /** Tolerances. */
  readonly durationToleranceMs?: number;
  readonly audioSyncToleranceMs?: number;
}

const DEFAULT_DURATION_TOLERANCE_MS = 750;
const DEFAULT_AUDIO_SYNC_TOLERANCE_MS = 750;

function check(id: QaCheckId, label: string, passed: boolean, explanation: string, evidence: string[], measured?: number | string | null, expected?: number | string | null): QaCheckResult {
  return { id, label, passed, explanation, evidence, measured: measured ?? null, expected: expected ?? null };
}

function qaMissingAssets(input: VideoQaInput): QaCheckResult {
  const evidence = input.snapshotScenes.map((s) => `${s.sceneId}: resolved=${s.assetResolved} materialized=${s.materialized}`);
  const unresolved = input.snapshotScenes.filter((s) => !s.assetResolved).map((s) => s.sceneId);
  const notMaterialized = input.snapshotScenes.filter((s) => s.assetResolved && !s.materialized).map((s) => s.sceneId);
  if (input.snapshotScenes.length === 0) {
    return check("missing_assets", "Missing Assets", false, "the render input snapshot contained no scenes", evidence);
  }
  const passed = unresolved.length === 0 && notMaterialized.length === 0;
  return check(
    "missing_assets",
    "Missing Assets",
    passed,
    passed
      ? "every required scene had a resolved asset that materialized for the render"
      : `scene(s) without a usable asset: ${[...unresolved, ...notMaterialized].join(", ")}`,
    evidence,
    input.snapshotScenes.filter((s) => s.assetResolved && s.materialized).length,
    input.snapshotScenes.length,
  );
}

function qaAudioSync(input: VideoQaInput): QaCheckResult {
  const tol = input.audioSyncToleranceMs ?? DEFAULT_AUDIO_SYNC_TOLERANCE_MS;
  const outMs = input.output.durationMs;
  const evidence = [
    `output duration: ${outMs ?? "unknown"}ms`,
    `narration duration: ${input.voice.durationMs}ms`,
    `output has audio track: ${input.output.hasAudioTrack}`,
    `narration word timings: ${input.voice.wordTimingCount}`,
  ];
  if (!input.output.hasAudioTrack) {
    return check("audio_sync", "Audio Sync", false, "the rendered file has no audio track", evidence, outMs, input.voice.durationMs);
  }
  if (input.voice.wordTimingCount <= 0 || input.voice.durationMs <= 0) {
    return check("audio_sync", "Audio Sync", false, "the narration artifact has no measurable duration or timing", evidence, outMs, input.voice.durationMs);
  }
  if (outMs === null) {
    return check("audio_sync", "Audio Sync", false, "could not inspect the rendered file duration", evidence, null, input.voice.durationMs);
  }
  const drift = Math.abs(outMs - input.voice.durationMs);
  const passed = drift <= tol;
  return check(
    "audio_sync",
    "Audio Sync",
    passed,
    passed ? `rendered length matches narration within ${tol}ms (drift ${drift}ms)` : `rendered length drifts ${drift}ms from narration (tolerance ${tol}ms)`,
    evidence,
    outMs,
    input.voice.durationMs,
  );
}

function qaSubtitleSync(input: VideoQaInput): QaCheckResult {
  const cues = input.subtitles.cues;
  const outMs = input.output.durationMs;
  const evidence = [
    `cue count: ${cues.length}`,
    `subtitle source audio: ${input.subtitles.sourceAudioAssetPublicId ?? "none"}`,
    `narration audio: ${input.voice.audioAssetPublicId ?? "none"}`,
    `output duration: ${outMs ?? "unknown"}ms`,
  ];
  if (cues.length === 0) {
    return check("subtitle_sync", "Subtitle Sync", false, "no subtitle cues are present", evidence);
  }
  if (!input.subtitles.sourceAudioAssetPublicId || input.subtitles.sourceAudioAssetPublicId !== input.voice.audioAssetPublicId) {
    return check("subtitle_sync", "Subtitle Sync", false, "subtitles were not built from the current narration audio", evidence, input.subtitles.sourceAudioAssetPublicId, input.voice.audioAssetPublicId);
  }
  const problems: string[] = [];
  let prevEnd = -1;
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    if (!(c.endMs > c.startMs)) problems.push(`cue ${i + 1} has a non-positive duration`);
    if (c.startMs < prevEnd) problems.push(`cue ${i + 1} overlaps the previous cue`);
    if (outMs !== null && c.endMs > outMs + 50) problems.push(`cue ${i + 1} ends after the video`);
    prevEnd = c.endMs;
  }
  const passed = problems.length === 0;
  return check(
    "subtitle_sync",
    "Subtitle Sync",
    passed,
    passed ? "all cues are monotonic, non-overlapping, within the video, and built from the rendered narration" : problems.slice(0, 3).join("; "),
    evidence,
    cues.length,
    null,
  );
}

function qaResolution(input: VideoQaInput): QaCheckResult {
  const evidence = [
    `inspected: ${input.output.width ?? "?"}x${input.output.height ?? "?"}`,
    `expected (${input.expectedProfileId}): ${input.expectedWidth}x${input.expectedHeight}`,
    `container structurally valid: ${input.output.containerOk}`,
  ];
  const passed = input.output.containerOk && input.output.width === input.expectedWidth && input.output.height === input.expectedHeight;
  return check(
    "resolution",
    "Resolution",
    passed,
    passed ? "rendered dimensions match the export profile" : "rendered dimensions do not match the export profile",
    evidence,
    input.output.width !== null && input.output.height !== null ? `${input.output.width}x${input.output.height}` : null,
    `${input.expectedWidth}x${input.expectedHeight}`,
  );
}

function qaDuration(input: VideoQaInput): QaCheckResult {
  const tol = input.durationToleranceMs ?? DEFAULT_DURATION_TOLERANCE_MS;
  const outMs = input.output.durationMs;
  const evidence = [`inspected duration: ${outMs ?? "unknown"}ms`, `expected timeline: ${input.expectedDurationMs}ms`, `tolerance: ${tol}ms`];
  if (outMs === null) {
    return check("duration", "Duration", false, "could not inspect the rendered file duration", evidence, null, input.expectedDurationMs);
  }
  const drift = Math.abs(outMs - input.expectedDurationMs);
  const passed = drift <= tol;
  return check(
    "duration",
    "Duration",
    passed,
    passed ? `duration within ${tol}ms of the expected timeline (drift ${drift}ms)` : `duration drifts ${drift}ms from the expected timeline`,
    evidence,
    outMs,
    input.expectedDurationMs,
  );
}

function qaBranding(input: VideoQaInput): QaCheckResult {
  const b = input.branding;
  const evidence = [
    `branding layer configured: ${b.layerConfigured}`,
    `logo/brand asset in render snapshot: ${b.logoAssetInSnapshot}`,
    `intro required/rendered: ${b.introRequired}/${b.introRendered}`,
    `outro required/rendered: ${b.outroRequired}/${b.outroRendered}`,
  ];
  const problems: string[] = [];
  if (!b.layerConfigured) problems.push("no branding layer was configured for the render");
  if (b.layerConfigured && !b.logoAssetInSnapshot) problems.push("branding layer is configured but no brand asset was in the render snapshot");
  if (b.introRequired && !b.introRendered) problems.push("an intro is required by brand config but was not rendered");
  if (b.outroRequired && !b.outroRendered) problems.push("an outro is required by brand config but was not rendered");
  const passed = problems.length === 0;
  return check("branding", "Branding", passed, passed ? "required branding elements were present in the render" : problems.join("; "), evidence);
}

export function runVideoQa(input: VideoQaInput): QaReport {
  const checks = [qaMissingAssets(input), qaAudioSync(input), qaSubtitleSync(input), qaResolution(input), qaDuration(input), qaBranding(input)];
  return { checks, passed: checks.every((c) => c.passed), generatedAt: new Date().toISOString() };
}
