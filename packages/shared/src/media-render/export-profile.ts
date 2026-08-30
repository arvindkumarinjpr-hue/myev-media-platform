/**
 * Module 7 Phase 7.5 — deterministic export profiles for the render
 * engine (VIDEO_AUTOMATION_ENGINE_V1.0.md §7 "Export profiles" + the six
 * "Supported Outputs"). One authoritative registry: width, height,
 * aspect, fps, codecs, container, and a quality target (CRF for
 * software x264/x265-class encoders). The render engine and every QA
 * check read expected output geometry from here — never from a
 * request-supplied dimension.
 */

// Reuses the frozen "Supported Outputs" list already declared for the
// agent contracts — kept in sync with the Prisma `VideoTargetPlatform`
// enum (apps/api).
import { VIDEO_TARGET_PLATFORMS, type VideoTargetPlatform } from "../agent-framework/agents/video-brief-agent";

export interface ExportProfile {
  /** Stable id — equals the target platform it serves (1:1 in V1). */
  readonly id: VideoTargetPlatform;
  readonly width: number;
  readonly height: number;
  /** Human-readable ratio, e.g. "16:9" — derived, kept explicit for QA evidence. */
  readonly aspectRatio: string;
  readonly fps: number;
  readonly videoCodec: "h264";
  readonly audioCodec: "aac";
  readonly container: "mp4";
  /** Constant Rate Factor target for x264-class encoders (lower = higher quality). */
  readonly crf: number;
  /** Nominal audio bitrate in kbps. */
  readonly audioBitrateKbps: number;
  /** Orientation, derived — used by the subtitle safe-area logic. */
  readonly orientation: "landscape" | "portrait" | "square";
}

function ratio(w: number, h: number): string {
  const g = (a: number, b: number): number => (b === 0 ? a : g(b, a % b));
  const d = g(w, h);
  return `${w / d}:${h / d}`;
}

function orientation(w: number, h: number): ExportProfile["orientation"] {
  if (w === h) return "square";
  return w > h ? "landscape" : "portrait";
}

function profile(id: VideoTargetPlatform, width: number, height: number, fps: number, crf: number): ExportProfile {
  return {
    id,
    width,
    height,
    aspectRatio: ratio(width, height),
    fps,
    videoCodec: "h264",
    audioCodec: "aac",
    container: "mp4",
    crf,
    audioBitrateKbps: 192,
    orientation: orientation(width, height),
  };
}

/**
 * The frozen six. 1080p class across the board (single-VPS V1, §21.1),
 * 30fps for narration-driven content. Vertical formats are 1080x1920;
 * square is 1080x1080; the presentation profile is 1080p landscape at a
 * slightly higher CRF (screen-share content compresses well).
 */
export const EXPORT_PROFILES: Readonly<Record<VideoTargetPlatform, ExportProfile>> = Object.freeze({
  YOUTUBE_LONG: profile("YOUTUBE_LONG", 1920, 1080, 30, 20),
  YOUTUBE_SHORTS: profile("YOUTUBE_SHORTS", 1080, 1920, 30, 21),
  INSTAGRAM_REEL: profile("INSTAGRAM_REEL", 1080, 1920, 30, 21),
  FACEBOOK_REEL: profile("FACEBOOK_REEL", 1080, 1920, 30, 21),
  SQUARE_SOCIAL: profile("SQUARE_SOCIAL", 1080, 1080, 30, 21),
  LANDSCAPE_PRESENTATION: profile("LANDSCAPE_PRESENTATION", 1920, 1080, 30, 23),
});

export class ExportProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportProfileError";
  }
}

export function isVideoTargetPlatform(value: unknown): value is VideoTargetPlatform {
  return typeof value === "string" && (VIDEO_TARGET_PLATFORMS as readonly string[]).includes(value);
}

/** Resolves the profile for a target platform. Throws `ExportProfileError` on an unknown platform. */
export function resolveExportProfile(targetPlatform: string): ExportProfile {
  if (!isVideoTargetPlatform(targetPlatform)) {
    throw new ExportProfileError(`No export profile for target platform "${targetPlatform}" (known: ${VIDEO_TARGET_PLATFORMS.join(", ")})`);
  }
  return EXPORT_PROFILES[targetPlatform];
}

/** The export-profile id a target platform must render with — the platform id itself in V1. */
export function defaultExportProfileId(targetPlatform: VideoTargetPlatform): VideoTargetPlatform {
  return targetPlatform;
}
