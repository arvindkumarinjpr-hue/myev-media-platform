import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  VIDEO_RENDER_INPUT_SCHEMA_VERSION,
  deriveSceneTimeline,
  resolveExportProfile,
  validateVideoRenderInput,
  type VideoRenderInputV1,
} from "@myev/shared";
import type { AppConfig } from "../../config/configuration";
import { PrismaService } from "../../prisma/prisma.service";
import { currentSceneIds, narrationText, scriptVersionHash, sceneAssetFingerprint } from "./video-media-hash";
import type { VideoPipelineState, RenderSnapshotSceneRef } from "./video-pipeline.types";

export interface RenderInputBuildResult {
  ok: boolean;
  errors: string[];
  input: VideoRenderInputV1 | null;
  fences: {
    scriptVersionHash: string;
    sceneAssetFingerprint: string;
    voiceAudioAssetPublicId: string;
    subtitleVttAssetPublicId: string | null;
  } | null;
  snapshotScenes: RenderSnapshotSceneRef[];
  branding: {
    layerConfigured: boolean;
    logoRequired: boolean;
    introRequired: boolean;
    outroRequired: boolean;
  };
  expectedDurationMs: number | null;
  exportProfileId: string | null;
}

interface AssetRow {
  publicId: string;
  assetGroupId: string;
  assetType: string;
  status: string;
  objectKey: string;
  workspaceId: string;
}

/**
 * Module 7 Phase 7.5 — assembles the FROZEN `VideoRenderInputV1` snapshot
 * (checkpoint §4) from the CURRENT persisted pipeline artifacts:
 * ScenePlan V1 + resolved ACTIVE scene assets + approved Script + ACTIVE
 * Voice audio + current Subtitles + branding + export profile. Every
 * asset reference is resolved to its trusted internal object key here —
 * never a client URL (checkpoint §28). No mutable domain object crosses
 * into the render input.
 *
 * Validates fully (`validateVideoRenderInput` + `deriveSceneTimeline`)
 * before returning — a submission with any structural problem is
 * rejected before a render job is ever created (checkpoint §4/§11).
 */
@Injectable()
export class VideoRenderInputBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async build(params: {
    workspacePublicId: string;
    workspaceId: string;
    contentItemId: string;
    contentItemPublicId: string;
    targetPlatform: string;
    state: VideoPipelineState;
    correlationId: string;
  }): Promise<RenderInputBuildResult> {
    const { state } = params;
    const errors: string[] = [];
    const renderCfg = this.config.get("videoRender", { infer: true });
    // V1 branding is config-driven: MYEV brands every render (a text/colour
    // watermark layer the Remotion composition always applies). Logo
    // compositing + intro/outro frames are gated by config and default off
    // — QA only requires what config says is required (checkpoint §21).
    const branding = { layerConfigured: true, logoRequired: false, introRequired: renderCfg.introRequired, outroRequired: renderCfg.outroRequired };
    const empty: RenderInputBuildResult = {
      ok: false,
      errors,
      input: null,
      fences: null,
      snapshotScenes: [],
      branding,
      expectedDurationMs: null,
      exportProfileId: null,
    };

    // --- Prerequisites (checkpoint §11) ---
    if (state.script.status !== "APPROVED") errors.push("script is not approved (Quality Gate #1)");
    const plan = state.scenePlan.artifact;
    if (!plan || state.scenePlan.status !== "READY") errors.push("no current scene plan");
    if (state.assets.status !== "READY") errors.push(`Gate #2 (assets available) not passed: missing ${state.assets.missingScenes.join(", ") || "?"}`);
    if (state.voice.status !== "READY" || !state.voice.audioAssetPublicId) errors.push("Gate #3 (voice generated) not passed");
    if (state.subtitles.status !== "READY" || !state.subtitles.vttAssetPublicId) errors.push("subtitle state is not valid");

    let profile;
    try {
      profile = resolveExportProfile(params.targetPlatform);
    } catch {
      errors.push(`no export profile for target platform "${params.targetPlatform}"`);
    }
    if (errors.length > 0 || !plan || !profile) return { ...empty, errors };

    const sceneIds = currentSceneIds(plan);
    const scriptSegmentIds = (state.script.artifact?.segments ?? []).map((s) => s.id);

    // --- Resolve every asset's object key from live media_assets ---
    const scenePublicIds = state.assets.scenes.map((s) => s.mediaAssetPublicId).filter((x): x is string => !!x);
    const wantPublicIds = new Set<string>([...scenePublicIds, state.voice.audioAssetPublicId!, state.subtitles.vttAssetPublicId!]);
    const rows = await this.prisma.mediaAsset.findMany({
      where: { workspaceId: params.workspaceId, publicId: { in: [...wantPublicIds] }, deletedAt: null },
      select: { publicId: true, assetGroupId: true, assetType: true, status: true, objectKey: true, workspaceId: true },
    });
    const byPublicId = new Map<string, AssetRow>(rows.map((r) => [r.publicId, r]));

    // --- Per-scene refs + snapshot evidence ---
    const timelineScenes = [...plan.scenes]
      .sort((a, b) => a.order - b.order)
      .map((s) => ({ sceneId: s.sceneId, order: s.order, durationSeconds: s.durationSeconds, scriptSegmentRef: s.scriptSegmentRef, transition: s.transition }));

    const snapshotScenes: RenderSnapshotSceneRef[] = [];
    const sceneAssetPairs: Array<[string, string | null]> = [];
    const resolvedSceneIds: string[] = [];
    const renderSceneAssets = new Map<string, AssetRow>();
    for (const scene of state.assets.scenes) {
      const asset = scene.mediaAssetPublicId ? byPublicId.get(scene.mediaAssetPublicId) ?? null : null;
      const usable = !!asset && asset.status === "ACTIVE" && (asset.assetType === "IMAGE" || asset.assetType === "VIDEO");
      snapshotScenes.push({ sceneId: scene.sceneId, assetResolved: usable, materialized: false });
      sceneAssetPairs.push([scene.sceneId, scene.mediaAssetPublicId ?? null]);
      if (usable && asset) {
        resolvedSceneIds.push(scene.sceneId);
        renderSceneAssets.set(scene.sceneId, asset);
      }
    }

    // --- Deterministic timeline scaled to the narration audio ---
    const voiceDurationMs = state.voice.audioDurationMs ?? 0;
    const timeline = deriveSceneTimeline(timelineScenes, {
      voiceDurationMs,
      scriptSegmentIds,
      currentSceneIds: sceneIds,
      resolvedSceneIds,
    });
    if (!timeline.ok) return { ...empty, errors: timeline.errors, snapshotScenes };

    // --- Resolve audio / subtitle object keys ---
    const audioRow = byPublicId.get(state.voice.audioAssetPublicId!);
    const vttRow = byPublicId.get(state.subtitles.vttAssetPublicId!);
    if (!audioRow || audioRow.status !== "ACTIVE" || audioRow.assetType !== "AUDIO") errors.push("current voice audio asset is not ACTIVE");
    if (!vttRow || vttRow.status !== "ACTIVE" || vttRow.assetType !== "SUBTITLE") errors.push("current subtitle (VTT) asset is not ACTIVE");
    if (errors.length > 0) return { ...empty, errors, snapshotScenes };

    const input: VideoRenderInputV1 = {
      schemaVersion: VIDEO_RENDER_INPUT_SCHEMA_VERSION,
      workspacePublicId: params.workspacePublicId,
      contentItemPublicId: params.contentItemPublicId,
      targetPlatform: params.targetPlatform,
      exportProfileId: profile.id,
      width: profile.width,
      height: profile.height,
      fps: profile.fps,
      expectedDurationMs: timeline.totalDurationMs,
      scenes: timeline.timeline.map((t) => {
        const asset = renderSceneAssets.get(t.sceneId)!;
        return {
          order: t.order,
          sceneId: t.sceneId,
          scriptSegmentId: t.scriptSegmentId,
          startMs: t.startMs,
          durationMs: t.durationMs,
          transition: t.transition,
          asset: {
            assetGroupId: asset.assetGroupId,
            mediaAssetPublicId: asset.publicId,
            assetType: asset.assetType as "IMAGE" | "VIDEO",
            objectKey: asset.objectKey,
          },
        };
      }),
      audio: {
        audioAssetPublicId: audioRow!.publicId,
        objectKey: audioRow!.objectKey,
        durationMs: voiceDurationMs,
        scriptVersionHash: state.voice.scriptVersionHash ?? scriptVersionHash(state.script.artifact),
      },
      subtitles: {
        vttAssetPublicId: vttRow!.publicId,
        objectKey: vttRow!.objectKey,
        sourceAudioAssetPublicId: audioRow!.publicId,
        cueCount: state.subtitles.cueCount ?? 0,
      },
      branding: {
        layerConfigured: true,
        brandName: "MYEV",
        introRequired: branding.introRequired,
        outroRequired: branding.outroRequired,
      },
      correlationId: params.correlationId,
    };

    const structural = validateVideoRenderInput(input);
    if (!structural.ok) return { ...empty, errors: structural.errors, snapshotScenes };

    // Belt-and-braces: the derived narration text must be non-empty (the
    // render audio track is the authoritative narration).
    if (!narrationText(state.script.artifact)) return { ...empty, errors: ["approved script has no narration text"], snapshotScenes };

    return {
      ok: true,
      errors: [],
      input,
      fences: {
        scriptVersionHash: scriptVersionHash(state.script.artifact),
        sceneAssetFingerprint: sceneAssetFingerprint(sceneAssetPairs),
        voiceAudioAssetPublicId: audioRow!.publicId,
        subtitleVttAssetPublicId: vttRow!.publicId,
      },
      snapshotScenes,
      branding,
      expectedDurationMs: timeline.totalDurationMs,
      exportProfileId: profile.id,
    };
  }
}
