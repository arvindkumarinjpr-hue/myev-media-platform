import { randomUUID } from "crypto";
import { Prisma } from "../generated/prisma";
import {
  addActiveMemberWithRole,
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createWorkspaceAsOwner,
  loginAsPlatformOwner,
  request,
  teardownE2eApp,
  type E2eApp,
} from "./helpers/e2e-app";
import { scriptVersionHash, sceneAssetFingerprint } from "../src/modules/video/video-media-hash";

/**
 * Module 7 Phase 7.1 — Video Automation domain + pipeline foundation
 * (e2e).
 *
 * Phase 7.1 has no executable stages: `create` composes the Module 2 KP
 * gate + Module 1E content-item lifecycle, writes the 1:1 `video_scripts`
 * row + the `content_items.metadata.videoPipeline` bag, and stops with
 * the item IN_PROGRESS and every stage PENDING. These tests exercise that
 * foundation and the shared review-bypass seal — no AI provider is
 * involved.
 */

interface Workspace {
  id: string;
  publicId: string;
}

function helpers(getCtx: () => E2eApp, getToken: () => string) {
  const ctx = () => getCtx();
  const server = () => getCtx().app.getHttpServer();
  const auth = (ws: Workspace, token = getToken()) => ({ Authorization: `Bearer ${token}`, "X-Workspace-Id": ws.publicId });
  const base = (ws: Workspace) => `/api/v1/workspaces/${ws.publicId}/video`;
  const contentItemsBase = (ws: Workspace) => `/api/v1/workspaces/${ws.publicId}/content-items`;

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(getCtx(), getToken());
    const row = await getCtx().prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const create = await request(server())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(auth(ws))
      .send({ name: "Video Pipeline Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const packId = create.body.data.publicId as string;
    await request(server())
      .patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}`)
      .set(auth(ws))
      .send({
        expectedLockVersion: 1,
        sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
        promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
      })
      .expect(200);
    await request(server()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}/validate`).set(auth(ws)).expect(200);
    return packId;
  }

  async function createVideo(ws: Workspace, packId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(server())
      .post(base(ws))
      .set(auth(ws))
      .send({ topic: "Home EV charging explained", knowledgePackVersionId: packId, targetPlatform: "YOUTUBE_LONG", ...overrides })
      .expect(202);
    return res.body.data as Record<string, unknown>;
  }

  async function addMember(ws: Workspace, label: string, roleName: string) {
    const user = await createActiveUserAndLogin(getCtx(), label);
    await addActiveMemberWithRole(getCtx(), ws.id, user.userId, roleName);
    return user;
  }

  // ---- Phase 7.2: durable-job completion helpers (same established
  // technique as blog-pipeline.e2e-spec.ts's own completeStageJob — no
  // provider is configured in this test environment, so a real
  // ai.execute.v1 job FAILS quickly in the background Worker; each test
  // then overwrites the terminal ai_jobs row with a crafted, valid agent
  // output and drives the pipeline forward through a GET, which
  // reconciles real ai_jobs state into the pipeline). ----

  async function waitTerminal(ws: Workspace, aiJobPublicId: string): Promise<string> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const job = await ctx().prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: aiJobPublicId } });
      if (["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return job.status;
      await new Promise((r) => setTimeout(r, 100));
    }
    return "QUEUED";
  }

  async function completeStageJob(ws: Workspace, aiJobPublicId: string, output: Record<string, unknown>): Promise<void> {
    await waitTerminal(ws, aiJobPublicId);
    const job = await ctx().prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: aiJobPublicId } });
    await ctx().prisma.aiJob.update({
      where: { id: job.id },
      data: { status: "COMPLETED", outputPayload: output as object, errorCode: null, errorMessageSafe: null, completedAt: new Date() },
    });
    if (job.backgroundJobId) {
      await ctx().prisma.backgroundJob.update({ where: { id: job.backgroundJobId }, data: { status: "COMPLETED" } }).catch(() => undefined);
    }
  }

  async function failStageJob(ws: Workspace, aiJobPublicId: string, errorCode = "PROVIDER_ERROR"): Promise<void> {
    await waitTerminal(ws, aiJobPublicId);
    const job = await ctx().prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: aiJobPublicId } });
    await ctx().prisma.aiJob.update({ where: { id: job.id }, data: { status: "FAILED", outputPayload: Prisma.JsonNull, errorCode, errorMessageSafe: "simulated failure", completedAt: new Date() } });
  }

  const stageJobId = (data: Record<string, unknown>, key: string) => (data[key] as { aiJobPublicId: string | null }).aiJobPublicId as string;

  async function reconcileGet(ws: Workspace, itemId: string): Promise<Record<string, unknown>> {
    const r = await request(server()).get(`${base(ws)}/${itemId}`).set(auth(ws)).expect(200);
    return r.body.data;
  }

  async function cleanup(ws: Workspace): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const pending = await ctx().prisma.aiJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      const pendingBg = await ctx().prisma.backgroundJob.count({ where: { workspaceId: ws.id, status: { in: ["QUEUED", "RUNNING"] } } });
      if (pending === 0 && pendingBg === 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    await ctx().prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx().prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx().prisma.videoRenderJob.deleteMany({ where: { workspaceId: ws.id } }).catch(() => undefined);
    await ctx().prisma.mediaJob.deleteMany({ where: { workspaceId: ws.id } }).catch(() => undefined);
  }

  /** create → brief → script → script/approve (Gate #1). Returns itemId + the post-approve read model. */
  async function walkToScriptApproved(ws: Workspace, packId: string, overrides: Record<string, unknown> = {}): Promise<{ itemId: string; readModel: Record<string, unknown> }> {
    const create = await createVideo(ws, packId, overrides);
    const itemId = (create.contentItem as { publicId: string }).publicId;

    const brief = await request(server()).post(`${base(ws)}/${itemId}/brief`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(brief.body.data, "brief"), BRIEF_OUTPUT);
    await reconcileGet(ws, itemId);

    const script = await request(server()).post(`${base(ws)}/${itemId}/script`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(script.body.data, "script"), SCRIPT_OUTPUT);
    await reconcileGet(ws, itemId);

    const approved = await request(server()).post(`${base(ws)}/${itemId}/script/approve`).set(auth(ws)).expect(200);
    return { itemId, readModel: approved.body.data };
  }

  /** ...script approved → scene-plan → seo. Leaves the pipeline exactly where Gate #6 (SEO Complete) is satisfied and Gates #2–#5 are still PENDING (the honest, naturally-reachable Phase 7.3 boundary). */
  async function walkToSeoComplete(ws: Workspace, packId: string, overrides: Record<string, unknown> = {}): Promise<{ itemId: string }> {
    const { itemId } = await walkToScriptApproved(ws, packId, overrides);
    const scenePlan = await request(server()).post(`${base(ws)}/${itemId}/scene-plan`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    const seo = await request(server()).post(`${base(ws)}/${itemId}/seo`).set(auth(ws)).expect(202);
    await completeStageJob(ws, stageJobId(seo.body.data, "seo"), SEO_OUTPUT);
    await reconcileGet(ws, itemId);
    return { itemId };
  }

  /**
   * TEST-STATE SIMULATION — NOT a currently reachable production flow
   * (checkpoint §10/§27). Phases 7.4/7.5 (Asset Manager, Voice Engine,
   * Rendering Engine, QA Engine) do not exist yet, so Gates #2–#5 can
   * never be satisfied by real product code in Phase 7.3. This directly
   * crafts `metadata.videoPipeline` to mark those 4 gates satisfied —
   * exactly analogous to how blog-pipeline.e2e-spec.ts's own "already
   * running" test crafts pipeline state directly — so submit-for-review
   * / approve / reject / Gate #7 / Gate #8 can be exercised end-to-end
   * against REAL code (assertReadyForReview, ContentItemsService,
   * VideoScoringService) without waiting for those later phases.
   */
  async function createActiveMediaAsset(ws: Workspace, itemInternalId: string, createdById: string, assetType: string, mime: string): Promise<{ publicId: string; assetGroupId: string }> {
    const id = randomUUID();
    const row = await ctx().prisma.mediaAsset.create({
      data: {
        id,
        workspaceId: ws.id,
        contentItemId: itemInternalId,
        assetType: assetType as "IMAGE",
        originalFilename: `sim-${assetType}`,
        normalizedFilename: `sim-${assetType}`,
        storageProviderIdentity: "MINIO",
        bucket: "test",
        objectKey: `sim/${id}`,
        declaredMimeType: mime,
        declaredSizeBytes: BigInt(1000),
        verifiedMimeType: mime,
        verifiedSizeBytes: BigInt(1000),
        extension: ".bin",
        assetGroupId: id,
        versionNumber: 1,
        status: "ACTIVE",
        visibility: "WORKSPACE_PRIVATE",
        verifiedAt: new Date(),
        createdById,
      },
      select: { publicId: true, assetGroupId: true },
    });
    return row;
  }

  /**
   * TEST-STATE SIMULATION — NOT a currently reachable production flow
   * (checkpoint §10/§27). Gates #4/#5 (Render/QA) do not exist yet, so a
   * naturally-created item can never be review-eligible. Phase 7.4 DID
   * make Gates #2/#3 (Assets/Voice) real — so this helper now crafts the
   * REAL persisted artifacts the reconcile validates: ACTIVE MediaAsset
   * rows for each scene image, the narration audio (+ a matching COMPLETED
   * TTS media_job carrying the word-timing sidecar key + script hash), and
   * the SRT/VTT subtitles — plus the still-simulated Render/QA state.
   */
  async function simulateGates2Through5Satisfied(itemId: string): Promise<void> {
    const item = await ctx().prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { id: true, workspaceId: true, metadata: true, createdById: true } });
    const ws: Workspace = { id: item.workspaceId, publicId: "" };
    const md = item.metadata as { videoPipeline: Record<string, unknown> };
    const plan = (md.videoPipeline.scenePlan as { artifact: { scenes: { sceneId: string }[] } }).artifact;

    const scenes = [];
    for (const s of plan.scenes) {
      const a = await createActiveMediaAsset(ws, item.id, item.createdById, "IMAGE", "image/png");
      scenes.push({ sceneId: s.sceneId, mediaAssetGroupId: a.assetGroupId, mediaAssetPublicId: a.publicId, source: "ai_generated", mediaJobPublicId: null, failureReason: null });
    }
    md.videoPipeline.assets = { status: "READY", scenes, missingScenes: [], completedAt: new Date().toISOString(), failureReason: null };

    const audio = await createActiveMediaAsset(ws, item.id, item.createdById, "AUDIO", "audio/mpeg");
    const hash = scriptVersionHash(SCRIPT_OUTPUT as never);
    const timingKey = `sim/${audio.publicId}.timings.json`;
    await ctx().prisma.mediaJob.create({
      data: {
        workspaceId: item.workspaceId,
        contentItemId: item.id,
        operation: "TTS",
        status: "COMPLETED",
        correlationId: randomUUID(),
        inputPayload: {},
        outputPayload: { audioAssetPublicId: audio.publicId, wordTimingObjectKey: timingKey, durationMs: 8000, scriptVersionHash: hash, voiceProfileId: "en-in-neerja" },
        createdById: item.createdById,
        completedAt: new Date(),
      },
    });
    md.videoPipeline.voice = {
      status: "READY",
      audioAssetPublicId: audio.publicId,
      wordTimingObjectKey: timingKey,
      scriptVersionHash: hash,
      voiceProfileId: "en-in-neerja",
      audioDurationMs: 8000,
      mediaJobPublicId: null,
      failureReason: null,
    };

    const srt = await createActiveMediaAsset(ws, item.id, item.createdById, "SUBTITLE", "application/x-subrip");
    const vtt = await createActiveMediaAsset(ws, item.id, item.createdById, "SUBTITLE", "text/vtt");
    md.videoPipeline.subtitles = { status: "READY", srtAssetPublicId: srt.publicId, vttAssetPublicId: vtt.publicId, sourceAudioAssetPublicId: audio.publicId, cueCount: 4, mediaJobPublicId: null, failureReason: null };

    // Module 7 Phase 7.5 — Gate #4 (render) + Gate #5 (QA) are now
    // reconciled from live truth, so this must build a REAL COMPLETED
    // video_render_jobs row + a REAL ACTIVE VIDEO MediaAsset whose
    // checksum + geometry + frozen snapshot fences all line up with the
    // current script / scene assets / voice / subtitles. (The full
    // HTTP -> BullMQ -> render-worker path is covered by
    // video-render-qa.e2e-spec.ts + apps/worker's video-render.e2e.)
    const video = await createActiveMediaAsset(ws, item.id, item.createdById, "VIDEO", "video/mp4");
    const checksum = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
    await ctx().prisma.mediaAsset.update({ where: { publicId: video.publicId }, data: { verifiedChecksumSha256: checksum } });
    const fp = sceneAssetFingerprint(scenes.map((s) => [s.sceneId, s.mediaAssetPublicId] as [string, string | null]));
    const renderJob = await ctx().prisma.videoRenderJob.create({
      data: {
        workspaceId: item.workspaceId,
        contentItemId: item.id,
        targetPlatform: "YOUTUBE_LONG",
        exportProfileId: "YOUTUBE_LONG",
        renderInputSnapshot: {} as object,
        renderInputVersion: 1,
        scriptVersionHash: hash,
        sceneAssetFingerprint: fp,
        voiceAudioAssetPublicId: audio.publicId,
        subtitleVttAssetPublicId: vtt.publicId,
        status: "COMPLETED",
        outputMediaAssetPublicId: video.publicId,
        outputMediaAssetGroupId: video.assetGroupId,
        outputWidth: 1920,
        outputHeight: 1080,
        outputDurationMs: 8000,
        outputFps: 30,
        outputByteSize: BigInt(4096),
        outputChecksumSha256: checksum,
        outputContainer: "mp4",
        renderEngine: "deterministic-test",
        correlationId: randomUUID(),
        createdById: item.createdById,
        completedAt: new Date(),
      },
    });
    const snapshotScenes = scenes.map((s) => ({ sceneId: s.sceneId, assetResolved: true, materialized: true }));
    md.videoPipeline.render = {
      status: "READY",
      renderJobPublicId: renderJob.publicId,
      renderedVideoPublicId: video.publicId,
      renderedVideoAssetGroupId: video.assetGroupId,
      exportProfileId: "YOUTUBE_LONG",
      attempt: 1,
      expectedDurationMs: 8000,
      outputWidth: 1920,
      outputHeight: 1080,
      outputDurationMs: 8000,
      outputChecksumSha256: checksum,
      outputByteSize: 4096,
      scriptVersionHash: hash,
      sceneAssetFingerprint: fp,
      voiceAudioAssetPublicId: audio.publicId,
      subtitleVttAssetPublicId: vtt.publicId,
      snapshotScenes,
      brandingLayerConfigured: true,
      brandingLogoInSnapshot: false,
      brandingIntroRequired: false,
      brandingIntroRendered: false,
      brandingOutroRequired: false,
      brandingOutroRendered: false,
      completedAt: new Date().toISOString(),
      failureReason: null,
    };
    md.videoPipeline.qa = {
      status: "COMPLETED",
      passed: true,
      renderJobPublicId: renderJob.publicId,
      renderedVideoPublicId: video.publicId,
      checks: ["missing_assets", "audio_sync", "subtitle_sync", "resolution", "duration", "branding"].map((id) => ({ id, label: id, passed: true, explanation: "ok", evidence: [] })),
      completedAt: new Date().toISOString(),
    };
    await ctx().prisma.contentItem.update({ where: { id: item.id }, data: { metadata: md as object } });
  }

  /** walkToSeoComplete + the simulated Gates #2–#5 + a real passing score. Genuinely reaches submit-for-review-eligible via real assertReadyForReview/VideoScoringService code. */
  async function walkToReviewEligible(ws: Workspace, packId: string): Promise<{ itemId: string }> {
    const { itemId } = await walkToSeoComplete(ws, packId);
    await simulateGates2Through5Satisfied(itemId);
    await request(server()).post(`${base(ws)}/${itemId}/score`).set(auth(ws)).expect(201);
    return { itemId };
  }

  return {
    ctx,
    server,
    auth,
    base,
    contentItemsBase,
    createWorkspace,
    createActivePack,
    createVideo,
    addMember,
    waitTerminal,
    completeStageJob,
    failStageJob,
    stageJobId,
    reconcileGet,
    cleanup,
    walkToScriptApproved,
    walkToSeoComplete,
    simulateGates2Through5Satisfied,
    walkToReviewEligible,
  };
}

const BRIEF_OUTPUT = {
  objective: "Show a new EV owner how to start home charging in under a minute.",
  audience: "New EV owners without a home charger yet",
  targetPlatform: "YOUTUBE_LONG",
  durationSeconds: 120,
  cta: "Book a free home charger install assessment.",
  rationale: "A how-to angle for buyers who haven't installed a charger yet.",
};
const SCRIPT_OUTPUT = {
  hook: "Charging your EV at home is easier than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Hook", narration: "Charging your EV at home is easier than you think.", purpose: "stop the scroll" },
    { order: 2, id: "seg-2", label: "Setup", narration: "Plug in, pick a schedule, done.", purpose: "show the steps" },
  ],
  cta: "Book a free install assessment.",
  // In production, VIDEO_SCRIPT_AGENT_V1's own postProcessOutput renders
  // this deterministically from hook/segments/cta before the ai_jobs row
  // is ever marked COMPLETED — completeStageJob() crafts the row
  // directly, bypassing postProcessOutput, so the fixture supplies the
  // already-rendered body explicitly to match what a real completed job
  // actually contains.
  scriptBody: "HOOK: Charging your EV at home is easier than you think.\n\n[seg-1] Hook\nCharging your EV at home is easier than you think.\n\n[seg-2] Setup\nPlug in, pick a schedule, done.\n\nCTA: Book a free install assessment.",
};
const SCENE_PLAN_OUTPUT = {
  scenePlanVersion: 1,
  targetPlatform: "YOUTUBE_LONG",
  scenes: [
    {
      order: 1,
      sceneId: "scene-1",
      scriptSegmentRef: "seg-1",
      startSeconds: 0,
      durationSeconds: 3,
      visualInstruction: "Close on hands plugging in a charger.",
      transition: "cut",
      assetRequirements: [{ kind: "video_clip", description: "Plugging in a Level 2 charger", sourceHint: "stock" }],
    },
    {
      order: 2,
      sceneId: "scene-2",
      scriptSegmentRef: "seg-2",
      startSeconds: 3,
      durationSeconds: 3,
      visualInstruction: "Phone app showing a charge schedule.",
      transition: "fade",
      assetRequirements: [{ kind: "image", description: "Charging app UI", sourceHint: "ai_generated" }],
    },
  ],
};
const SEO_OUTPUT = {
  metaTitle: "Home EV Charging: The Complete Setup Guide",
  metaDescription: "Everything you need to charge your EV at home.",
  tags: ["ev charging", "home charger"],
  chapters: [{ startSeconds: 0, title: "Intro" }],
  hashtags: ["#ev", "#homecharging"],
  schemaMarkup: { "@type": "VideoObject", name: "Home EV Charging: The Complete Setup Guide", description: "A guide to home EV charging.", duration: "PT2M0S" },
};
const THUMBNAIL_OUTPUT = {
  concepts: [
    { title: "Shocked reaction", visualDirection: "Owner pointing at a low bill", overlayText: "SO CHEAP?!", composition: "Face left, bill right", ctrHypothesis: "Curiosity gap on price." },
    { title: "Before/after", visualDirection: "Split screen gas vs charger", overlayText: "NEVER AGAIN", composition: "Vertical split", ctrHypothesis: "Instant visual contrast." },
  ],
};
const RECOMMENDATIONS_OUTPUT = {
  recommendations: [{ kind: "stronger_hook", suggestion: "Open on the electric bill number.", rationale: "A concrete number earns more retention than an abstract claim." }],
};

// ===========================================================================
describe("Video pipeline — Phase 7.1 foundation (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  const h = helpers(() => ctx, () => ownerToken);

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  // ---- Creation ----------------------------------------------------------
  it("creates a VIDEO pipeline item: content_item (VIDEO/IN_PROGRESS) + 1:1 video_scripts row + videoPipeline bag", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);

    const readModel = await h.createVideo(ws, packId, { topic: "  Trimmed topic  ", durationSecondsTarget: 480 });
    const itemId = (readModel.contentItem as { publicId: string }).publicId;

    expect((readModel.contentItem as { contentType: string }).contentType).toBe("VIDEO");
    expect((readModel.contentItem as { status: string }).status).toBe("IN_PROGRESS");
    expect((readModel.contentItem as { title: string }).title).toBe("Trimmed topic");
    expect((readModel.videoScript as { targetPlatform: string }).targetPlatform).toBe("YOUTUBE_LONG");
    expect((readModel.videoScript as { durationSecondsTarget: number }).durationSecondsTarget).toBe(480);
    expect(readModel.currentStage).toBe("BRIEF");
    expect(readModel.publishReady).toBe(false);
    expect(readModel.canSubmitForReview).toBe(false);

    const row = await ctx.prisma.contentItem.findFirstOrThrow({
      where: { publicId: itemId },
      include: { videoScript: true, versions: true },
    });
    expect(row.contentType).toBe("VIDEO");
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.videoScript).not.toBeNull();
    expect(row.videoScript?.targetPlatform).toBe("YOUTUBE_LONG");
    expect(row.videoScript?.scriptBody).toBeNull();
    expect(row.videoScript?.scenePlan).toBeNull();
    expect(row.videoScript?.metaTitle).toBeNull();
    expect(row.versions.length).toBe(1);
    expect((row.metadata as Record<string, unknown>).videoPipeline).toBeTruthy();
  });

  it("creates a Shorts-targeted video as contentType VIDEO with targetPlatform YOUTUBE_SHORTS (SHORT/REEL ContentTypes deferred)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const readModel = await h.createVideo(ws, packId, { targetPlatform: "YOUTUBE_SHORTS" });
    expect((readModel.contentItem as { contentType: string }).contentType).toBe("VIDEO");
    expect((readModel.videoScript as { targetPlatform: string }).targetPlatform).toBe("YOUTUBE_SHORTS");
  });

  it("every frozen target platform is accepted", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    for (const targetPlatform of ["YOUTUBE_LONG", "YOUTUBE_SHORTS", "INSTAGRAM_REEL", "FACEBOOK_REEL", "SQUARE_SOCIAL", "LANDSCAPE_PRESENTATION"]) {
      const rm = await h.createVideo(ws, packId, { targetPlatform });
      expect((rm.videoScript as { targetPlatform: string }).targetPlatform).toBe(targetPlatform);
    }
  });

  // ---- Input validation -------------------------------------------------
  it("rejects a missing target platform with 400 (FR-VID-001)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "No platform", knowledgePackVersionId: packId }).expect(400);
  });

  it("rejects an unsupported target platform value with 400", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "x", knowledgePackVersionId: packId, targetPlatform: "TIKTOK" }).expect(400);
  });

  it("rejects an empty topic with 400", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    await request(h.server()).post(h.base(ws)).set(h.auth(ws)).send({ topic: "", knowledgePackVersionId: packId, targetPlatform: "YOUTUBE_LONG" }).expect(400);
  });

  it("rejects a non-ACTIVE Knowledge Pack with 422 VIDEO_KNOWLEDGE_PACK_NOT_ACTIVE", async () => {
    const ws = await h.createWorkspace();
    // A brand-new draft pack (never validated) is not ACTIVE.
    const create = await request(h.server())
      .post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`)
      .set(h.auth(ws))
      .send({ name: "Draft Pack", industryProfile: { industry: "EV" }, publishingStrategy: { cadence: "weekly" } })
      .expect(201);
    const draftPackId = create.body.data.publicId as string;
    const res = await request(h.server())
      .post(h.base(ws))
      .set(h.auth(ws))
      .send({ topic: "x", knowledgePackVersionId: draftPackId, targetPlatform: "YOUTUBE_LONG" })
      .expect(422);
    expect(res.body.code).toBe("VIDEO_KNOWLEDGE_PACK_NOT_ACTIVE");
  });

  // ---- RBAC ------------------------------------------------------------
  it("VIDEO_CREATE is enforced — a Content Writer (no video permissions) gets 403", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const writer = await h.addMember(ws, "video-71-writer", "Content Writer");
    await request(h.server())
      .post(h.base(ws))
      .set({ Authorization: `Bearer ${writer.accessToken}`, "X-Workspace-Id": ws.publicId })
      .send({ topic: "nope", knowledgePackVersionId: packId, targetPlatform: "YOUTUBE_LONG" })
      .expect(403);
  });

  it("VIDEO_VIEW is enforced — an Analyst (no content read) gets 403 on list and detail", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const rm = await h.createVideo(ws, packId);
    const itemId = (rm.contentItem as { publicId: string }).publicId;
    const analyst = await h.addMember(ws, "video-71-analyst", "Analyst");
    const analystAuth = { Authorization: `Bearer ${analyst.accessToken}`, "X-Workspace-Id": ws.publicId };
    await request(h.server()).get(h.base(ws)).set(analystAuth).expect(403);
    await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(analystAuth).expect(403);
  });

  it("a Video Editor (VIDEO_CREATE + VIDEO_VIEW) can create and read", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const editor = await h.addMember(ws, "video-71-editor", "Video Editor");
    const editorAuth = { Authorization: `Bearer ${editor.accessToken}`, "X-Workspace-Id": ws.publicId };
    const created = await request(h.server())
      .post(h.base(ws))
      .set(editorAuth)
      .send({ topic: "Editor video", knowledgePackVersionId: packId, targetPlatform: "INSTAGRAM_REEL" })
      .expect(202);
    const itemId = (created.body.data.contentItem as { publicId: string }).publicId;
    await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(editorAuth).expect(200);
    await request(h.server()).get(h.base(ws)).set(editorAuth).expect(200);
  });

  // ---- List & detail --------------------------------------------------
  it("lists only pipeline videos with a compact summary; a plain Module 1E VIDEO item is excluded", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    await h.createVideo(ws, packId, { topic: "Pipeline one" });
    await h.createVideo(ws, packId, { topic: "Pipeline two", targetPlatform: "SQUARE_SOCIAL" });
    // A generic (non-pipeline) VIDEO content item.
    await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "VIDEO", title: "Plain video", body: { script: "A plain script." } })
      .expect(201);

    const list = await request(h.server()).get(h.base(ws)).set(h.auth(ws)).expect(200);
    const rows = list.body.data as Array<Record<string, unknown>>;
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.title).sort()).toEqual(["Pipeline one", "Pipeline two"]);
    expect(rows.every((r) => r.brief === "PENDING" && r.script === "PENDING")).toBe(true);
    expect(rows.find((r) => r.title === "Pipeline two")?.targetPlatform).toBe("SQUARE_SOCIAL");
  });

  it("detail returns the full read model with all stages PENDING and a BRIEF current stage", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const rm = await h.createVideo(ws, packId);
    const itemId = (rm.contentItem as { publicId: string }).publicId;

    const detail = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(h.auth(ws)).expect(200);
    const d = detail.body.data as Record<string, unknown>;
    for (const key of ["brief", "script", "scenePlan", "assets", "voice", "subtitles", "render", "qa", "seo", "thumbnailConcepts", "recommendations"]) {
      expect(d).toHaveProperty(key);
    }
    expect((d.brief as { status: string }).status).toBe("PENDING");
    expect((d.render as { status: string }).status).toBe("PENDING");
    expect((d.qa as { status: string }).status).toBe("PENDING");
    expect((d.thumbnailConcepts as { advisory: boolean }).advisory).toBe(true);
    expect((d.recommendations as { advisory: boolean }).advisory).toBe(true);
    expect(d.currentStage).toBe("BRIEF");
    expect(d.publishReady).toBe(false);
    expect(d.reviewGatesUnmet).toEqual(["script_approved", "assets_available", "voice_generated", "rendering_successful", "qa_passed", "seo_complete", "content_score_run"]);
  });

  it("detail 404s for a non-pipeline / unknown / wrong-type item", async () => {
    const ws = await h.createWorkspace();
    await request(h.server()).get(`${h.base(ws)}/11111111-1111-1111-1111-111111111111`).set(h.auth(ws)).expect(404);
    // A BLOG item is not reachable through the video route.
    const blog = await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "BLOG", title: "A blog", body: { content: "hi" } })
      .expect(201);
    await request(h.server()).get(`${h.base(ws)}/${blog.body.data.publicId}`).set(h.auth(ws)).expect(404);
  });

  it("a plain Module 1E VIDEO item is reported as VIDEO_NOT_A_PIPELINE_ITEM (422) by the video read model", async () => {
    const ws = await h.createWorkspace();
    const plain = await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "VIDEO", title: "Plain", body: { script: "s" } })
      .expect(201);
    const res = await request(h.server()).get(`${h.base(ws)}/${plain.body.data.publicId}`).set(h.auth(ws)).expect(422);
    expect(res.body.code).toBe("VIDEO_NOT_A_PIPELINE_ITEM");
  });

  // ---- Pure read behaviour ------------------------------------------
  it("GET is a pure read — repeated GETs are byte-identical and never mutate the row, versions, or audit log", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const rm = await h.createVideo(ws, packId);
    const itemId = (rm.contentItem as { publicId: string }).publicId;

    const before = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, include: { versions: true } });
    const auditBefore = await ctx.prisma.auditLog.count({ where: { entityId: itemId } });

    const g1 = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(h.auth(ws)).expect(200);
    const g2 = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(h.auth(ws)).expect(200);
    const g3 = await request(h.server()).get(`${h.base(ws)}/${itemId}`).set(h.auth(ws)).expect(200);
    expect(g1.body).toEqual(g2.body);
    expect(g2.body).toEqual(g3.body);

    const after = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, include: { versions: true } });
    const auditAfter = await ctx.prisma.auditLog.count({ where: { entityId: itemId } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(JSON.stringify(after.metadata)).toBe(JSON.stringify(before.metadata));
    expect(after.versions.length).toBe(before.versions.length);
    expect(auditAfter).toBe(auditBefore);
  });

  // ---- Workspace isolation ----------------------------------------
  it("workspace isolation — a video created in workspace A is a 404 through workspace B, and B's list never shows it", async () => {
    const wsA = await h.createWorkspace();
    const wsB = await h.createWorkspace();
    const packA = await h.createActivePack(wsA);
    const rm = await h.createVideo(wsA, packA);
    const itemId = (rm.contentItem as { publicId: string }).publicId;

    await request(h.server()).get(`${h.base(wsB)}/${itemId}`).set(h.auth(wsB)).expect(404);
    const listB = await request(h.server()).get(h.base(wsB)).set(h.auth(wsB)).expect(200);
    expect(listB.body.data).toEqual([]);

    const scriptRows = await ctx.prisma.videoScript.findMany({ where: { workspaceId: wsB.id } });
    expect(scriptRows.length).toBe(0);
  });

  // ---- Review-bypass protection ----------------------------------
  it("a video pipeline item CANNOT enter REVIEW through the generic content-items route — CONTENT_ITEM_VIDEO_REVIEW_VIA_PIPELINE (409), status unchanged", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const rm = await h.createVideo(ws, packId);
    const itemId = (rm.contentItem as { publicId: string }).publicId;

    const res = await request(h.server())
      .post(`${h.contentItemsBase(ws)}/${itemId}/submit-for-review`)
      .set(h.auth(ws))
      .send({})
      .expect(409);
    expect(res.body.code).toBe("CONTENT_ITEM_VIDEO_REVIEW_VIA_PIPELINE");

    const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } });
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("a video pipeline item that is not in REVIEW cannot be forced to APPROVED through the generic approve route", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const rm = await h.createVideo(ws, packId);
    const itemId = (rm.contentItem as { publicId: string }).publicId;

    const res = await request(h.server()).post(`${h.contentItemsBase(ws)}/${itemId}/approve`).set(h.auth(ws)).send({}).expect(409);
    expect(res.body.code).toBe("CONTENT_ITEM_INVALID_TRANSITION");
    const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } });
    expect(row.status).toBe("IN_PROGRESS");
  });

  it("a PLAIN Module 1E VIDEO item (no pipeline bag) is NOT sealed — it still submits for review through the generic route", async () => {
    const ws = await h.createWorkspace();
    const plain = await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "VIDEO", title: "Plain video", body: { script: "A plain script." } })
      .expect(201);
    const itemId = plain.body.data.publicId as string;
    await request(h.server()).post(`${h.contentItemsBase(ws)}/${itemId}/start`).set(h.auth(ws)).expect(200);
    const submit = await request(h.server()).post(`${h.contentItemsBase(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).send({}).expect(200);
    expect(submit.body.data.status).toBe("REVIEW");
  });

  it("the existing BLOG review-bypass seal is unchanged — a generic BLOG submit-for-review still returns CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE", async () => {
    const ws = await h.createWorkspace();
    const blog = await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "BLOG", title: "A blog", body: { content: "hi" } })
      .expect(201);
    const itemId = blog.body.data.publicId as string;
    await request(h.server()).post(`${h.contentItemsBase(ws)}/${itemId}/start`).set(h.auth(ws)).expect(200);
    const res = await request(h.server()).post(`${h.contentItemsBase(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).send({}).expect(409);
    expect(res.body.code).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");
  });

  // ---- ContentType boundary ------------------------------------
  it("the generic content-items route still rejects SHORT/REEL content types (Module 1E unchanged)", async () => {
    const ws = await h.createWorkspace();
    for (const contentType of ["SHORT", "REEL"]) {
      // Rejected at the DTO layer (@IsIn(["BLOG","VIDEO"])) — a plain
      // ValidationPipe 400, same as NEWSLETTER/SOCIAL_POST today.
      await request(h.server())
        .post(h.contentItemsBase(ws))
        .set(h.auth(ws))
        .send({ contentType, title: "x", body: { script: "s" } })
        .expect(400);
    }
    const created = await ctx.prisma.contentItem.count({ where: { workspaceId: ws.id, contentType: { in: ["SHORT", "REEL"] } } });
    expect(created).toBe(0);
  });
});

// ===========================================================================
describe("Video pipeline — Phase 7.2 text agents (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  const h = helpers(() => ctx, () => ownerToken);

  // Every unmet gate assertion below is against THIS constant: Phase 7.2
  // never advances assets/voice/subtitles/render/qa (Phases 7.4/7.5), so
  // those four gates stay unmet for the whole phase no matter how far the
  // text pipeline (brief→script→scenePlan→seo) progresses. currentStage
  // is pinned to "ASSETS" the moment scenePlan is READY, for the same
  // reason — deriveStage walks the FROZEN 8-stage order, and Phase 7.2
  // deliberately lets SEO run ahead of Assets/Voice/Render (its only
  // prerequisite is Gate #1, not the full upstream chain). Phase 7.3
  // added the scoring gate (content_score_run/content_score_passed) —
  // these Phase 7.2 tests never run a score, so it's always unmet too.
  const MEDIA_GATES_UNMET = ["assets_available", "voice_generated", "rendering_successful", "qa_passed", "content_score_run"];

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  it("happy path: brief → script → approve (Gate #1) → scene-plan → seo (Gate #6) → thumbnail-concepts → recommendations", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId, readModel: afterApprove } = await h.walkToScriptApproved(ws, packId);

    expect((afterApprove.script as { scriptApproved: boolean }).scriptApproved).toBe(true);
    expect((afterApprove.script as { artifact: { hook: string } }).artifact.hook).toBe(SCRIPT_OUTPUT.hook);
    expect(afterApprove.currentStage).toBe("SCENE_PLAN");
    expect(afterApprove.reviewGatesUnmet).not.toContain("script_approved");
    expect(afterApprove.reviewGatesUnmet).toContain("seo_complete");

    // video_scripts.script_body is persisted once the script is READY —
    // materialized by walkToScriptApproved's own approve call (its
    // finalizeStages reconciles + persists the script artifact before
    // checking approval eligibility).
    const scriptRow = await ctx.prisma.videoScript.findFirstOrThrow({ where: { contentItem: { publicId: itemId } } });
    expect(scriptRow.scriptBody).toBe(SCRIPT_OUTPUT.scriptBody);

    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);

    // Materialize scenePlan by chaining the next legitimate mutating call
    // (its own finalizeStages persists scenePlan before doing anything
    // else) rather than asserting on a bare GET's un-materialized artifact.
    const seo = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    const afterScenePlanMaterialized = await h.reconcileGet(ws, itemId);
    expect((afterScenePlanMaterialized.scenePlan as { status: string }).status).toBe("READY");
    expect(afterScenePlanMaterialized.currentStage).toBe("ASSETS");

    const scenePlanRow = await ctx.prisma.videoScript.findFirstOrThrow({ where: { contentItem: { publicId: itemId } } });
    expect((scenePlanRow.scenePlan as { scenes: unknown[] }).scenes.length).toBe(2);

    await h.completeStageJob(ws, h.stageJobId(seo.body.data, "seo"), SEO_OUTPUT);
    const thumbs = await request(h.server()).post(`${h.base(ws)}/${itemId}/thumbnail-concepts`).set(h.auth(ws)).expect(202);
    const afterSeoMaterialized = await h.reconcileGet(ws, itemId);
    expect((afterSeoMaterialized.seo as { seoComplete: boolean }).seoComplete).toBe(true);
    expect(afterSeoMaterialized.reviewGatesUnmet).toEqual(MEDIA_GATES_UNMET); // Gate #1 + #6 clear; #2/#3/#4/#5 pending (Phase 7.4/7.5)
    expect(afterSeoMaterialized.currentStage).toBe("ASSETS");

    const seoRow = await ctx.prisma.videoScript.findFirstOrThrow({ where: { contentItem: { publicId: itemId } } });
    expect(seoRow.metaTitle).toBe(SEO_OUTPUT.metaTitle);
    expect((seoRow.schemaMarkup as { "@type": string })["@type"]).toBe("VideoObject");

    await h.completeStageJob(ws, h.stageJobId(thumbs.body.data, "thumbnailConcepts"), THUMBNAIL_OUTPUT);
    const afterThumbs = await h.reconcileGet(ws, itemId);
    expect((afterThumbs.thumbnailConcepts as { status: string; advisory: boolean }).status).toBe("READY");
    expect((afterThumbs.thumbnailConcepts as { advisory: boolean }).advisory).toBe(true);

    const recs = await request(h.server()).post(`${h.base(ws)}/${itemId}/recommendations`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(recs.body.data, "recommendations"), RECOMMENDATIONS_OUTPUT);
    const afterRecs = await h.reconcileGet(ws, itemId);
    expect((afterRecs.recommendations as { status: string; advisory: boolean }).status).toBe("READY");
    // Advisory generation never touches the mandatory gates.
    expect(afterRecs.reviewGatesUnmet).toEqual(MEDIA_GATES_UNMET);

    await h.cleanup(ws);
  });

  it("script generation requires a READY brief (VIDEO_BRIEF_NOT_READY)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;
    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/script`).set(h.auth(ws)).expect(422);
    expect(res.body.code).toBe("VIDEO_BRIEF_NOT_READY");
    await h.cleanup(ws);
  });

  it("scene planning is BLOCKED before Quality Gate #1 (script approved) — VIDEO_SCRIPT_NOT_APPROVED", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;

    const brief = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(brief.body.data, "brief"), BRIEF_OUTPUT);
    const script = await request(h.server()).post(`${h.base(ws)}/${itemId}/script`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(script.body.data, "script"), SCRIPT_OUTPUT);
    // Script is READY but NOT yet approved — both blocked stages force
    // their own finalizeStages first, so this holds regardless of
    // whether a bare GET has materialized the script yet.
    const blocked = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(422);
    expect(blocked.body.code).toBe("VIDEO_SCRIPT_NOT_APPROVED");

    const seoBlocked = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(422);
    expect(seoBlocked.body.code).toBe("VIDEO_SCRIPT_NOT_APPROVED");

    await h.cleanup(ws);
  });

  it("rejects approving a script that is not yet generated / still generating", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;
    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/script/approve`).set(h.auth(ws)).expect(422);
    expect(res.body.code).toBe("VIDEO_SCRIPT_NOT_READY");
    await h.cleanup(ws);
  });

  it("the versioned Scene Plan (D8) is rejected — both on GET and the next mutating call — when it leaves a script segment uncovered", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);

    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    // seg-2 is never covered — malformed per the D8 contract.
    const incomplete = { ...SCENE_PLAN_OUTPUT, scenes: [SCENE_PLAN_OUTPUT.scenes[0]] };
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), incomplete);

    // A bare GET already reflects the cross-field rejection (projectStages
    // runs the same validateVideoScenePlan check as finalizeStages).
    const afterGet = await h.reconcileGet(ws, itemId);
    expect((afterGet.scenePlan as { status: string; failureReason: string }).status).toBe("FAILED");
    expect((afterGet.scenePlan as { failureReason: string }).failureReason).toContain("not covered by any scene");

    // Never persisted onto video_scripts as if valid — a mutating call
    // (retry the scene plan) confirms the row was never written.
    await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    const row = await ctx.prisma.videoScript.findFirstOrThrow({ where: { contentItem: { publicId: itemId } } });
    expect(row.scenePlan).toBeNull();

    await h.cleanup(ws);
  });

  it("downstream invalidation: regenerating the BRIEF resets script (+ Gate #1 approval) and scene plan", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);

    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    await h.reconcileGet(ws, itemId);

    const regenBrief = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(202);
    const afterClaim = regenBrief.body.data as Record<string, unknown>;
    expect((afterClaim.script as { status: string; scriptApproved: boolean }).status).toBe("PENDING");
    expect((afterClaim.script as { scriptApproved: boolean }).scriptApproved).toBe(false);
    expect((afterClaim.scenePlan as { status: string }).status).toBe("PENDING");
    expect(afterClaim.currentStage).toBe("BRIEF");

    await h.completeStageJob(ws, h.stageJobId(afterClaim, "brief"), { ...BRIEF_OUTPUT, objective: "A second, revised objective." });
    // Prove the regenerated content actually flows downstream: submit
    // script generation (its own finalizeStages materializes the new
    // brief; buildAgentInput reads the materialized artifact) and check
    // the NEW ai_job's input carries the revised objective.
    const newScript = await request(h.server()).post(`${h.base(ws)}/${itemId}/script`).set(h.auth(ws)).expect(202);
    const newScriptJob = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: h.stageJobId(newScript.body.data, "script") } });
    expect((newScriptJob.inputPayload as { objective: string }).objective).toBe("A second, revised objective.");

    await h.cleanup(ws);
  });

  it("downstream invalidation: regenerating the SCRIPT resets Gate #1 approval and scene plan, but not the brief", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);
    const briefBefore = await h.reconcileGet(ws, itemId);

    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    await h.reconcileGet(ws, itemId);

    const regenScript = await request(h.server()).post(`${h.base(ws)}/${itemId}/script`).set(h.auth(ws)).expect(202);
    const afterClaim = regenScript.body.data as Record<string, unknown>;
    expect((afterClaim.script as { scriptApproved: boolean }).scriptApproved).toBe(false);
    expect((afterClaim.scenePlan as { status: string }).status).toBe("PENDING");
    // Brief is untouched by a script regeneration.
    expect(afterClaim.brief).toEqual(briefBefore.brief);

    await h.completeStageJob(ws, h.stageJobId(afterClaim, "script"), { ...SCRIPT_OUTPUT, hook: "A completely new hook." });
    await request(h.server()).post(`${h.base(ws)}/${itemId}/script/approve`).set(h.auth(ws)).expect(200);
    const afterNewScript = await h.reconcileGet(ws, itemId);
    expect((afterNewScript.script as { artifact: { hook: string } }).artifact.hook).toBe("A completely new hook.");

    await h.cleanup(ws);
  });

  it("scene-plan regeneration does NOT reset script approval and does NOT reset SEO (a sibling stage)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);

    const scenePlan1 = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan1.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    const seo = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(seo.body.data, "seo"), SEO_OUTPUT);

    // Materialize seo via the next mutating call (scene-plan regen itself).
    const firstScenePlanJobId = h.stageJobId(scenePlan1.body.data, "scenePlan"); // pre-regen reference
    const scenePlan2 = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    const afterClaim = scenePlan2.body.data as Record<string, unknown>;
    expect((afterClaim.script as { scriptApproved: boolean }).scriptApproved).toBe(true); // untouched
    expect((afterClaim.seo as { seoComplete: boolean }).seoComplete).toBe(true); // untouched — a sibling, not downstream
    // scenePlan ITSELF was reclaimed — proven by a fresh ai_job id, not by
    // its transient status (a live, provider-less Worker races to
    // auto-fail a just-submitted job, so asserting an exact "GENERATING"
    // snapshot is inherently flaky; a new job id is timing-independent).
    const newScenePlanJobId = h.stageJobId(afterClaim, "scenePlan");
    expect(newScenePlanJobId).toBeTruthy();
    expect(newScenePlanJobId).not.toBe(firstScenePlanJobId);

    await h.cleanup(ws);
  });

  it("SEO regeneration only affects the SEO artifact/Gate #6 — script approval and scene plan are untouched", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);

    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    const seo1 = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(seo1.body.data, "seo"), SEO_OUTPUT);
    const before = await h.reconcileGet(ws, itemId); // seo derived-READY; script/scenePlan already materialized above

    const seo2 = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    const afterClaim = seo2.body.data as Record<string, unknown>;
    // Script/scene-plan are byte-identical — a SEO regen never touches them.
    expect(afterClaim.script).toEqual(before.script);
    expect(afterClaim.scenePlan).toEqual(before.scenePlan);

    await h.completeStageJob(ws, h.stageJobId(afterClaim, "seo"), { ...SEO_OUTPUT, metaTitle: "A revised title" });
    // Materialize via an unrelated mutating call (thumbnail-concepts is
    // independent of seo but its own finalizeStages reconciles EVERY
    // stage, seo included, before doing anything else).
    await request(h.server()).post(`${h.base(ws)}/${itemId}/thumbnail-concepts`).set(h.auth(ws)).expect(202);
    const scriptRow = await ctx.prisma.videoScript.findFirstOrThrow({ where: { contentItem: { publicId: itemId } } });
    expect(scriptRow.metaTitle).toBe("A revised title");

    await h.cleanup(ws);
  });

  it("thumbnail concepts and recommendations are advisory: a FAILED generation never blocks review-gate progress or the other stage", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);

    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    const seo = await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(seo.body.data, "seo"), SEO_OUTPUT);

    const thumbs = await request(h.server()).post(`${h.base(ws)}/${itemId}/thumbnail-concepts`).set(h.auth(ws)).expect(202);
    await h.failStageJob(ws, h.stageJobId(thumbs.body.data, "thumbnailConcepts"), "PROVIDER_TIMEOUT");
    const afterThumbFail = await h.reconcileGet(ws, itemId);
    expect((afterThumbFail.thumbnailConcepts as { status: string }).status).toBe("FAILED");
    expect(afterThumbFail.reviewGatesUnmet).toEqual(MEDIA_GATES_UNMET); // unaffected by the advisory failure

    const recs = await request(h.server()).post(`${h.base(ws)}/${itemId}/recommendations`).set(h.auth(ws)).expect(202);
    await h.failStageJob(ws, h.stageJobId(recs.body.data, "recommendations"), "PROVIDER_TIMEOUT");
    const afterRecsFail = await h.reconcileGet(ws, itemId);
    expect((afterRecsFail.recommendations as { status: string }).status).toBe("FAILED");
    expect(afterRecsFail.reviewGatesUnmet).toEqual(MEDIA_GATES_UNMET);
    // seo/scenePlan/script are all completely unaffected by two advisory failures.
    expect((afterRecsFail.seo as { seoComplete: boolean }).seoComplete).toBe(true);
    expect((afterRecsFail.scenePlan as { status: string }).status).toBe("READY");
    expect((afterRecsFail.script as { scriptApproved: boolean }).scriptApproved).toBe(true);

    await h.cleanup(ws);
  });

  it("a real provider failure never fabricates a completed stage (FAILED, no artifact, recoverable by regeneration)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;

    const brief = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(202);
    await h.failStageJob(ws, h.stageJobId(brief.body.data, "brief"), "PROVIDER_NOT_CONFIGURED");
    const afterFail = await h.reconcileGet(ws, itemId);
    expect((afterFail.brief as { status: string; artifact: unknown; failureReason: string | null }).status).toBe("FAILED");
    expect((afterFail.brief as { artifact: unknown }).artifact).toBeNull();
    expect((afterFail.brief as { failureReason: string | null }).failureReason).toBeTruthy();

    // Recoverable: a fresh brief request works normally.
    const retry = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(retry.body.data, "brief"), BRIEF_OUTPUT);
    const afterRetry = await h.reconcileGet(ws, itemId);
    expect((afterRetry.brief as { status: string }).status).toBe("READY");

    await h.cleanup(ws);
  });

  it("a stage already GENERATING cannot be double-submitted (409 VIDEO_STAGE_ALREADY_RUNNING)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;

    // Force the brief stage to a stable GENERATING with an ai_job id that
    // resolves to nothing (finalizeStages leaves such a stage untouched)
    // — isolates the concurrency guard from the provider-less real
    // Worker's near-instant auto-fail of an actually-submitted job (the
    // same technique blog-pipeline.e2e-spec.ts uses for its own
    // equivalent test).
    const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { id: true, metadata: true } });
    const md = row.metadata as { videoPipeline: { brief: Record<string, unknown> } };
    md.videoPipeline.brief = { ...md.videoPipeline.brief, status: "GENERATING", aiJobPublicId: "00000000-0000-0000-0000-0000000000aa", failureReason: null };
    await ctx.prisma.contentItem.update({ where: { id: row.id }, data: { metadata: md as object } });

    const read = await h.reconcileGet(ws, itemId);
    expect((read.brief as { status: string }).status).toBe("GENERATING");
    const dup = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(409);
    expect(dup.body.code).toBe("VIDEO_STAGE_ALREADY_RUNNING");

    await h.cleanup(ws);
  });

  it("SEO_EDIT is required for the SEO stage — a Video Editor (VIDEO_EDIT only) gets 403", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);
    const editor = await h.addMember(ws, "video-72-editor-seo", "Video Editor");
    const editorAuth = { Authorization: `Bearer ${editor.accessToken}`, "X-Workspace-Id": ws.publicId };

    // The Video Editor CAN generate brief/script/scene-plan/thumbnails (VIDEO_EDIT)...
    const scenePlan = await request(h.server()).post(`${h.base(ws)}/${itemId}/scene-plan`).set(editorAuth).expect(202);
    await h.completeStageJob(ws, h.stageJobId(scenePlan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);

    // ...but not the SEO stage (SEO_EDIT, which Video Editor does not hold).
    await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(editorAuth).expect(403);

    await h.cleanup(ws);
  });

  it("every generation submission creates a real, deterministically-referenced ai_jobs row bound to the EXACT locked Knowledge Pack version (ADR-004)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;
    const packRow = await ctx.prisma.knowledgePack.findFirstOrThrow({ where: { publicId: packId } });

    const brief = await request(h.server()).post(`${h.base(ws)}/${itemId}/brief`).set(h.auth(ws)).expect(202);
    const jobPublicId = h.stageJobId(brief.body.data, "brief");
    const jobRow = await ctx.prisma.aiJob.findFirstOrThrow({ where: { publicId: jobPublicId } });
    expect(jobRow.agentName).toBe("video-brief-agent");
    expect(jobRow.agentVersion).toBe(1);
    expect(jobRow.knowledgePackId).toBe(packRow.id);
    expect(jobRow.backgroundJobId).toBeTruthy();
    // status is deliberately not asserted here — a real background
    // Worker races to process it (this environment has no provider
    // configured, so it fails near-instantly); QUEUED/RUNNING/FAILED are
    // all valid depending purely on timing, none is a defect.

    // The read model exposes the exact metadata.videoPipeline.knowledgePackVersionId the pipeline was locked to at create time.
    const rm = await h.reconcileGet(ws, itemId);
    expect(rm.knowledgePackVersionId).toBe(packId);

    await h.cleanup(ws);
  });

  it("GET remains a pure read across the mutated (post-generation) state — repeated GETs are byte-identical and never mutate ai_jobs", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToScriptApproved(ws, packId);

    const jobCountBefore = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    const g1 = await h.reconcileGet(ws, itemId);
    const g2 = await h.reconcileGet(ws, itemId);
    expect(g1).toEqual(g2);
    const jobCountAfter = await ctx.prisma.aiJob.count({ where: { workspaceId: ws.id } });
    expect(jobCountAfter).toBe(jobCountBefore);

    await h.cleanup(ws);
  });
});

// ===========================================================================
describe("Video pipeline — Phase 7.3 scoring + review (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  const originalThreshold = process.env.CONTENT_SCORING_PASS_THRESHOLD;
  const h = helpers(() => ctx, () => ownerToken);

  beforeAll(async () => {
    // Low, deterministic threshold — these tests assert GATE MECHANICS
    // (run/not-run, passed/not-passed, fresh/stale), not score tuning.
    process.env.CONTENT_SCORING_PASS_THRESHOLD = "1";
    ctx = await bootstrapE2eApp();
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(async () => {
    await teardownE2eApp(ctx);
    if (originalThreshold === undefined) delete process.env.CONTENT_SCORING_PASS_THRESHOLD;
    else process.env.CONTENT_SCORING_PASS_THRESHOLD = originalThreshold;
  });

  it("GET score returns null data when the item has never been scored (pure read, never runs scoring — mirrors Blog's own GET :id/score contract)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const create = await h.createVideo(ws, packId);
    const itemId = (create.contentItem as { publicId: string }).publicId;

    const res = await request(h.server()).get(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(200);
    expect(res.body.data).toBeNull();
    const scoreCountBefore = await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id } });
    expect(scoreCountBefore).toBe(0);

    await h.cleanup(ws);
  });

  it("POST score runs the shared engine and persists Overall/category/Video Score via the append-only ContentScore architecture", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);

    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);
    const rm = res.body.data as Record<string, unknown>;
    expect((rm.score as { status: string }).status).toBe("COMPLETED");
    expect((rm.score as { overallScore: number }).overallScore).toBeGreaterThanOrEqual(0);
    expect((rm.score as { videoScore: number }).videoScore).toBeGreaterThanOrEqual(0);
    // No Thumbnail Concepts exist yet at this point in the walk — no fabricated Thumbnail Score.
    expect((rm.score as { thumbnailScore: number | null }).thumbnailScore).toBeNull();

    const row = await ctx.prisma.contentScore.findFirstOrThrow({ where: { workspaceId: ws.id, contentItemId: (await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } })).id } });
    expect(row.score).toBe((rm.score as { overallScore: number }).overallScore);
    const factors = row.factors as { dimension: { name: string }; thumbnail: unknown };
    expect(factors.dimension.name).toBe("video"); // the Overall Score's own dimension is Video, never Thumbnail
    expect(factors.thumbnail).toBeNull();

    const getRes = await request(h.server()).get(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(200);
    expect(getRes.body.data.overallScore).toBe((rm.score as { overallScore: number }).overallScore);
    expect(getRes.body.data.thumbnailScore).toBeNull();

    await h.cleanup(ws);
  });

  it("produces a separate, non-fabricated Thumbnail Score once a Thumbnail Concept exists — and it is data-model separate from Overall Score", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);

    const thumbs = await request(h.server()).post(`${h.base(ws)}/${itemId}/thumbnail-concepts`).set(h.auth(ws)).expect(202);
    await h.completeStageJob(ws, h.stageJobId(thumbs.body.data, "thumbnailConcepts"), THUMBNAIL_OUTPUT);

    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);
    const score = res.body.data.score as { overallScore: number; videoScore: number; thumbnailScore: number };
    expect(score.thumbnailScore).toBeGreaterThanOrEqual(0);
    expect(score.thumbnailScore).not.toBe(score.overallScore);
    expect(score.thumbnailScore).not.toBe(score.videoScore);

    const getRes = await request(h.server()).get(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(200);
    expect(getRes.body.data.thumbnailScore.name).toBe("thumbnail");
    expect(getRes.body.data.thumbnailScore.score).toBe(score.thumbnailScore);
    // The category-score breakdown belongs to the ONE Overall Score (Video's), never Thumbnail's own.
    expect(getRes.body.data.categoryScores).toBeTruthy();

    await h.cleanup(ws);
  });

  it("scoring is append-only — a second run creates a NEW content_scores row, the first is retained untouched", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    const itemRow = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } });

    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);
    const firstCount = await ctx.prisma.contentScore.count({ where: { contentItemId: itemRow.id } });
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);
    const secondCount = await ctx.prisma.contentScore.count({ where: { contentItemId: itemRow.id } });
    expect(secondCount).toBe(firstCount + 1);

    // Both rows are still there — never deleted/overwritten.
    const rows = await ctx.prisma.contentScore.findMany({ where: { contentItemId: itemRow.id } });
    expect(rows.length).toBe(2);

    await h.cleanup(ws);
  });

  it("score freshness: regenerating the SCRIPT invalidates a previous score (status → PENDING) without deleting the historical row", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);
    const before = await h.reconcileGet(ws, itemId);
    expect((before.score as { status: string }).status).toBe("COMPLETED");
    const historicalCountBefore = await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id } });

    await request(h.server()).post(`${h.base(ws)}/${itemId}/script`).set(h.auth(ws)).expect(202);
    const afterClaim = await h.reconcileGet(ws, itemId);
    expect((afterClaim.score as { status: string }).status).toBe("PENDING");

    const historicalCountAfter = await ctx.prisma.contentScore.count({ where: { workspaceId: ws.id } });
    expect(historicalCountAfter).toBe(historicalCountBefore); // nothing deleted

    await h.cleanup(ws);
  });

  it("score freshness: regenerating SEO invalidates the score; regenerating a Thumbnail Concept also invalidates it", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);

    await request(h.server()).post(`${h.base(ws)}/${itemId}/seo`).set(h.auth(ws)).expect(202);
    expect(((await h.reconcileGet(ws, itemId)).score as { status: string }).status).toBe("PENDING");
    await h.completeStageJob(ws, h.stageJobId((await h.reconcileGet(ws, itemId)), "seo"), SEO_OUTPUT);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);
    expect(((await h.reconcileGet(ws, itemId)).score as { status: string }).status).toBe("COMPLETED");

    const thumbs = await request(h.server()).post(`${h.base(ws)}/${itemId}/thumbnail-concepts`).set(h.auth(ws)).expect(202);
    expect(((await h.reconcileGet(ws, itemId)).score as { status: string }).status).toBe("PENDING");
    await h.completeStageJob(ws, h.stageJobId(thumbs.body.data, "thumbnailConcepts"), THUMBNAIL_OUTPUT);

    await h.cleanup(ws);
  });

  it("regenerating advisory RECOMMENDATIONS does NOT invalidate score freshness (never a scored input)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);

    await request(h.server()).post(`${h.base(ws)}/${itemId}/recommendations`).set(h.auth(ws)).expect(202);
    expect(((await h.reconcileGet(ws, itemId)).score as { status: string }).status).toBe("COMPLETED");

    await h.cleanup(ws);
  });

  it("VIDEO_VIEW is required for GET score; SEO_SCORE is required for POST score", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    const editor = await h.addMember(ws, "video-73-editor-score", "Video Editor"); // VIDEO_VIEW yes, SEO_SCORE no
    const editorAuth = { Authorization: `Bearer ${editor.accessToken}`, "X-Workspace-Id": ws.publicId };

    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201); // owner scores first so GET has something
    await request(h.server()).get(`${h.base(ws)}/${itemId}/score`).set(editorAuth).expect(200);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(editorAuth).expect(403);

    await h.cleanup(ws);
  });

  it("score routes are workspace-isolated (404 across workspaces)", async () => {
    const wsA = await h.createWorkspace();
    const wsB = await h.createWorkspace();
    const packA = await h.createActivePack(wsA);
    const { itemId } = await h.walkToSeoComplete(wsA, packA);
    await request(h.server()).post(`${h.base(wsA)}/${itemId}/score`).set(h.auth(wsA)).expect(201);

    await request(h.server()).get(`${h.base(wsB)}/${itemId}/score`).set(h.auth(wsB)).expect(404);
    await request(h.server()).post(`${h.base(wsB)}/${itemId}/score`).set(h.auth(wsB)).expect(404);

    await h.cleanup(wsA);
  });

  it("a naturally-created Phase 7.3 video CANNOT submit for review — Gates #2–#5 are structurally unreachable (EXPECTED)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/score`).set(h.auth(ws)).expect(201);

    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(422);
    // Gate #2 (assets) is first in the unmet list — its own error code.
    expect(res.body.code).toBe("VIDEO_ASSETS_NOT_AVAILABLE");

    const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } });
    expect(row.status).toBe("IN_PROGRESS");

    await h.cleanup(ws);
  });

  it("submit-for-review is blocked when the score has never been run, and again when it's below threshold", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId);
    await h.simulateGates2Through5Satisfied(itemId);

    // Gates #2-#5 satisfied but never scored.
    const neverScored = await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(422);
    expect(neverScored.body.code).toBe("VIDEO_SCORE_NOT_RUN");

    await h.cleanup(ws);
  });

  it("submit-for-review succeeds once every mandatory gate + a passing score are satisfied (controlled test fixture — see walkToReviewEligible)", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReviewEligible(ws, packId);

    const rm = await h.reconcileGet(ws, itemId);
    expect(rm.reviewGatesUnmet).toEqual([]);

    const submitted = await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(200);
    expect((submitted.body.data.contentItem as { status: string }).status).toBe("REVIEW");

    await h.cleanup(ws);
  });

  it("the generic content-items review route stays sealed (409) even for a fully gate-satisfied video pipeline item", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReviewEligible(ws, packId);

    const res = await request(h.server()).post(`${h.contentItemsBase(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(409);
    expect(res.body.code).toBe("CONTENT_ITEM_VIDEO_REVIEW_VIA_PIPELINE");

    await h.cleanup(ws);
  });

  it("VIDEO_APPROVE is required to approve or reject; a Video Editor (no VIDEO_APPROVE) is refused with 403", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReviewEligible(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(200);

    const editor = await h.addMember(ws, "video-73-editor-approve", "Video Editor");
    const editorAuth = { Authorization: `Bearer ${editor.accessToken}`, "X-Workspace-Id": ws.publicId };
    // VideoController's approve/reject use a static @RequirePermission(VIDEO_APPROVE)
    // (mirrors BlogController exactly) — 403, not the dynamic
    // ContentPermissionResolver's enumeration-safe 404 the GENERIC
    // content-items route uses.
    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/approve`).set(editorAuth).send({});
    expect(res.status).toBe(403);

    await h.cleanup(ws);
  });

  it("VIDEO_RENDER is required to submit a render; Content Manager (VIDEO_EDIT/APPROVE but no VIDEO_RENDER, per the frozen role matrix) is refused with 403, while a Video Editor (has VIDEO_RENDER) passes the permission gate and reaches pipeline-state business logic instead", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.createVideo(ws, packId);

    const manager = await h.addMember(ws, "video-73-manager-render", "Content Manager");
    const managerAuth = { Authorization: `Bearer ${manager.accessToken}`, "X-Workspace-Id": ws.publicId };
    // VideoController's render route is gated by a static
    // @RequirePermission(VIDEO_RENDER) (Phase 7.6 — split out from
    // VIDEO_EDIT specifically so "can edit a video" and "can submit a
    // real render job" are independently grantable). Content Manager has
    // VIDEO_EDIT/VIDEO_APPROVE but the frozen matrix does NOT grant it
    // VIDEO_RENDER.
    const managerRes = await request(h.server()).post(`${h.base(ws)}/${itemId}/render`).set(managerAuth).send({});
    expect(managerRes.status).toBe(403);

    const editor = await h.addMember(ws, "video-73-editor-render", "Video Editor");
    const editorAuth = { Authorization: `Bearer ${editor.accessToken}`, "X-Workspace-Id": ws.publicId };
    // A freshly created item has no approved script/ready assets/voice —
    // the permission GUARD still must pass before the request ever
    // reaches that pipeline-state check, so the meaningful assertion
    // here is "not a 403" (the guard is satisfied), not any particular
    // success/failure status from the business logic beyond it.
    const editorRes = await request(h.server()).post(`${h.base(ws)}/${itemId}/render`).set(editorAuth).send({});
    expect(editorRes.status).not.toBe(403);

    await h.cleanup(ws);
  });

  it("approve requires the item to be in REVIEW — direct approval from IN_PROGRESS is rejected", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToSeoComplete(ws, packId); // still IN_PROGRESS — never submitted

    const res = await request(h.server()).post(`${h.base(ws)}/${itemId}/approve`).set(h.auth(ws)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("CONTENT_ITEM_INVALID_TRANSITION");

    await h.cleanup(ws);
  });

  it("reject requires a non-empty comment", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReviewEligible(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(200);

    const blank = await request(h.server()).post(`${h.base(ws)}/${itemId}/reject`).set(h.auth(ws)).send({ comment: "   " });
    expect(blank.status).toBe(400);

    const rejected = await request(h.server()).post(`${h.base(ws)}/${itemId}/reject`).set(h.auth(ws)).send({ comment: "Needs a stronger hook." }).expect(200);
    expect(rejected.body.data.contentItem.status).toBe("IN_PROGRESS");

    await h.cleanup(ws);
  });

  it("Human Approval Gate #7 + Publish Ready Gate #8: approving from REVIEW sets APPROVED and publishReady, with no publishing side effects", async () => {
    const ws = await h.createWorkspace();
    const packId = await h.createActivePack(ws);
    const { itemId } = await h.walkToReviewEligible(ws, packId);
    await request(h.server()).post(`${h.base(ws)}/${itemId}/submit-for-review`).set(h.auth(ws)).expect(200);

    const beforeApprove = await h.reconcileGet(ws, itemId);
    expect(beforeApprove.publishReady).toBe(false);

    const approved = await request(h.server()).post(`${h.base(ws)}/${itemId}/approve`).set(h.auth(ws)).send({ comment: "LGTM" }).expect(200);
    expect((approved.body.data.contentItem as { status: string }).status).toBe("APPROVED");
    expect(approved.body.data.publishReady).toBe(true);

    // Gate #8 stops here — Module 9 territory is never touched.
    const row = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId } });
    expect(row.status).toBe("APPROVED");
    expect(row.status).not.toBe("PUBLISHED");
    expect(row.status).not.toBe("SCHEDULED");

    await h.cleanup(ws);
  });

  // ---- Module 6 regressions (Blog scoring / Blog review unchanged) ----
  it("Module 6 regression: the generic content-items score endpoint still works unchanged for a BLOG item", async () => {
    const ws = await h.createWorkspace();
    const blog = await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "BLOG", title: "A regression blog post", body: { content: "Charging an EV at home is convenient and affordable for most drivers who plug in nightly." } })
      .expect(201);
    const blogId = blog.body.data.publicId as string;
    const res = await request(h.server()).post(`${h.contentItemsBase(ws)}/${blogId}/score`).set(h.auth(ws)).expect(201);
    expect(res.body.data.dimension.name).toBe("blog");

    await h.cleanup(ws);
  });

  it("Module 6 regression: the Blog pipeline's own review seal is unchanged", async () => {
    const ws = await h.createWorkspace();
    const blog = await request(h.server())
      .post(h.contentItemsBase(ws))
      .set(h.auth(ws))
      .send({ contentType: "BLOG", title: "A blog", body: { content: "hi" } })
      .expect(201);
    const blogId = blog.body.data.publicId as string;
    await request(h.server()).post(`${h.contentItemsBase(ws)}/${blogId}/start`).set(h.auth(ws)).expect(200);
    const res = await request(h.server()).post(`${h.contentItemsBase(ws)}/${blogId}/submit-for-review`).set(h.auth(ws)).send({}).expect(409);
    expect(res.body.code).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");

    await h.cleanup(ws);
  });
});
