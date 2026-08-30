import { createHash } from "crypto";
import type { VideoScriptAgentOutput, VideoScenePlannerAgentOutput } from "@myev/shared";

/**
 * Module 7 Phase 7.4 — deterministic content hashes used as freshness
 * fences. A voice artifact records the hash of the script it was
 * generated from; Gate #3 fails when the current script hash no longer
 * matches. Subtitles fence against the audio asset's publicId directly.
 */
export function scriptVersionHash(script: VideoScriptAgentOutput | null): string {
  if (!script) return "";
  const canonical = JSON.stringify({
    hook: script.hook ?? "",
    scriptBody: script.scriptBody ?? "",
    segments: (script.segments ?? []).map((s) => ({ id: s.id, label: s.label, narration: s.narration })),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/** The narration text a voice job synthesizes — the script's authoritative spoken words, in order. */
export function narrationText(script: VideoScriptAgentOutput | null): string {
  if (!script) return "";
  const parts: string[] = [];
  if (script.hook) parts.push(script.hook);
  for (const seg of script.segments ?? []) {
    if (seg.narration) parts.push(seg.narration);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Scene ids of the current ScenePlan, in `order`. Empty when no plan exists. */
export function currentSceneIds(plan: VideoScenePlannerAgentOutput | null): string[] {
  if (!plan) return [];
  return [...(plan.scenes ?? [])].sort((a, b) => a.order - b.order).map((s) => s.sceneId);
}

/**
 * Module 7 Phase 7.5 — freshness fence over the exact resolved scene
 * assets a render was built from. `pairs` is `[sceneId, mediaAssetPublicId]`
 * for every current scene, in order. Gate #4 recomputes this from live
 * state and compares it to what the render job froze — a regenerated or
 * re-attached scene asset changes the fingerprint and invalidates the
 * render's currentness (checkpoint §10/§24).
 */
export function sceneAssetFingerprint(pairs: Array<[string, string | null]>): string {
  const canonical = [...pairs]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([sceneId, assetPublicId]) => `${sceneId}=${assetPublicId ?? ""}`)
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
