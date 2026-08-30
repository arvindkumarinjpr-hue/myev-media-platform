import { randomUUID } from "crypto";
import { bootstrapE2eApp, createActiveUserAndLogin, createWorkspaceAsOwner, addActiveMemberWithRole, loginAsPlatformOwner, request, teardownE2eApp, type E2eApp } from "./helpers/e2e-app";
import { scriptVersionHash } from "../src/modules/video/video-media-hash";

/**
 * Module 7 Phase 7.4 — Video media stages (asset resolution + Gate #2,
 * voice + Gate #3, deterministic subtitles, thumbnail selection + image),
 * exercised through the real routes + the real reconcile/gate code.
 *
 * A `media.*` job's terminal state + its MediaAsset are crafted directly
 * here (the same established technique video-pipeline.e2e-spec.ts uses for
 * `ai.execute.v1` via completeStageJob — no provider runs in the API e2e
 * process). The full worker-processor path (provider → object store →
 * ACTIVE MediaAsset) is covered by apps/worker's media-processors e2e.
 *
 * KEY INVARIANT under test: even after Gates #2 and #3 pass, a naturally-
 * created item still CANNOT submit for review, because Gates #4 (Render)
 * and #5 (QA) remain unimplemented.
 */

interface Workspace {
  id: string;
  publicId: string;
}

const SCRIPT_OUTPUT = {
  hook: "Charging your EV at home is easier than you think.",
  segments: [
    { order: 1, id: "seg-1", label: "Hook", narration: "Charging your EV at home is easier than you think.", purpose: "hook" },
    { order: 2, id: "seg-2", label: "Setup", narration: "Plug in, pick a schedule, done.", purpose: "steps" },
  ],
  cta: "Book a free install assessment.",
  scriptBody: "HOOK: Charging your EV at home is easier than you think.\n\n[seg-1] Hook\nCharging your EV at home is easier than you think.\n\n[seg-2] Setup\nPlug in, pick a schedule, done.\n\nCTA: Book a free install assessment.",
};
const BRIEF_OUTPUT = { objective: "Show a new EV owner how to start home charging.", audience: "New EV owners", targetPlatform: "YOUTUBE_LONG", durationSeconds: 120, cta: "Book an assessment.", rationale: "How-to angle." };
const SCENE_PLAN_OUTPUT = {
  scenePlanVersion: 1,
  targetPlatform: "YOUTUBE_LONG",
  scenes: [
    { order: 1, sceneId: "scene-1", scriptSegmentRef: "seg-1", startSeconds: 0, durationSeconds: 3, visualInstruction: "Close on hands plugging in a charger.", transition: "cut", assetRequirements: [{ kind: "image", description: "Plugging in", sourceHint: "ai_generated" }] },
    { order: 2, sceneId: "scene-2", scriptSegmentRef: "seg-2", startSeconds: 3, durationSeconds: 3, visualInstruction: "Phone app showing a charge schedule.", transition: "fade", assetRequirements: [{ kind: "image", description: "App UI", sourceHint: "ai_generated" }] },
  ],
};
const SEO_OUTPUT = { metaTitle: "Home EV Charging Guide", metaDescription: "Everything about home charging.", tags: ["ev charging"], chapters: [{ startSeconds: 0, title: "Intro" }], hashtags: ["#ev"], schemaMarkup: { "@type": "VideoObject", name: "Home EV Charging Guide", description: "guide", duration: "PT2M0S" } };
const THUMBNAIL_OUTPUT = {
  concepts: [
    { title: "Shocked reaction", visualDirection: "Owner pointing at a low bill", overlayText: "SO CHEAP?!", composition: "Face left, bill right", ctrHypothesis: "Curiosity gap on price and savings." },
    { title: "Before/after", visualDirection: "Split screen gas vs charger", overlayText: "NEVER AGAIN", composition: "Vertical split", ctrHypothesis: "Instant visual contrast drives the click." },
  ],
};

describe("Video media — Phase 7.4 (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    ownerToken = (await loginAsPlatformOwner(ctx)).accessToken;
  });
  afterAll(() => teardownE2eApp(ctx));

  const server = () => ctx.app.getHttpServer();
  const auth = (ws: Workspace, token = ownerToken) => ({ Authorization: `Bearer ${token}`, "X-Workspace-Id": ws.publicId });
  const base = (ws: Workspace) => `/api/v1/workspaces/${ws.publicId}/video`;

  async function createWorkspace(): Promise<Workspace> {
    const ws = await createWorkspaceAsOwner(ctx, ownerToken);
    const row = await ctx.prisma.workspace.findFirstOrThrow({ where: { publicId: ws.publicId }, select: { id: true } });
    return { id: row.id, publicId: ws.publicId };
  }

  async function createActivePack(ws: Workspace): Promise<string> {
    const create = await request(server()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs`).set(auth(ws)).send({ name: "Pack", industryProfile: { industry: "Electric Vehicles" }, publishingStrategy: { cadence: "weekly" } }).expect(201);
    const packId = create.body.data.publicId as string;
    await request(server()).patch(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}`).set(auth(ws)).send({
      expectedLockVersion: 1,
      sources: [{ sourceType: "GOVERNMENT", url: "https://example.gov" }],
      promptTemplates: ["BLOG", "VIDEO", "SHORT", "REEL", "NEWSLETTER", "SOCIAL_POST"].map((contentType) => ({ contentType, promptBody: `Write ${contentType}` })),
    }).expect(200);
    await request(server()).post(`/api/v1/workspaces/${ws.publicId}/knowledge-packs/${packId}/validate`).set(auth(ws)).expect(200);
    return packId;
  }

  async function waitTerminalAi(ws: Workspace, publicId: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const job = await ctx.prisma.aiJob.findFirst({ where: { workspaceId: ws.id, publicId } });
      if (job && ["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function completeAiJob(ws: Workspace, publicId: string, output: Record<string, unknown>): Promise<void> {
    await waitTerminalAi(ws, publicId);
    const job = await ctx.prisma.aiJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId } });
    await ctx.prisma.aiJob.update({ where: { id: job.id }, data: { status: "COMPLETED", outputPayload: output as object, errorCode: null, completedAt: new Date() } });
    if (job.backgroundJobId) await ctx.prisma.backgroundJob.update({ where: { id: job.backgroundJobId }, data: { status: "COMPLETED" } }).catch(() => undefined);
  }
  const aiJobId = (data: Record<string, unknown>, key: string) => (data[key] as { aiJobPublicId: string }).aiJobPublicId;
  const get = async (ws: Workspace, id: string) => (await request(server()).get(`${base(ws)}/${id}`).set(auth(ws)).expect(200)).body.data;

  async function walkToSeoComplete(ws: Workspace, packId: string): Promise<string> {
    const create = await request(server()).post(base(ws)).set(auth(ws)).send({ topic: "Home EV charging", knowledgePackVersionId: packId, targetPlatform: "YOUTUBE_LONG" }).expect(202);
    const id = create.body.data.contentItem.publicId as string;
    const brief = await request(server()).post(`${base(ws)}/${id}/brief`).set(auth(ws)).expect(202);
    await completeAiJob(ws, aiJobId(brief.body.data, "brief"), BRIEF_OUTPUT);
    await get(ws, id);
    const script = await request(server()).post(`${base(ws)}/${id}/script`).set(auth(ws)).expect(202);
    await completeAiJob(ws, aiJobId(script.body.data, "script"), SCRIPT_OUTPUT);
    await get(ws, id);
    await request(server()).post(`${base(ws)}/${id}/script/approve`).set(auth(ws)).expect(200);
    const plan = await request(server()).post(`${base(ws)}/${id}/scene-plan`).set(auth(ws)).expect(202);
    await completeAiJob(ws, aiJobId(plan.body.data, "scenePlan"), SCENE_PLAN_OUTPUT);
    const seo = await request(server()).post(`${base(ws)}/${id}/seo`).set(auth(ws)).expect(202);
    await completeAiJob(ws, aiJobId(seo.body.data, "seo"), SEO_OUTPUT);
    await get(ws, id);
    return id;
  }

  async function createActiveAsset(ws: Workspace, itemInternalId: string, createdById: string, assetType: string, mime: string, groupId?: string): Promise<{ publicId: string; assetGroupId: string }> {
    const id = randomUUID();
    const g = groupId ?? id;
    const version = groupId ? (await ctx.prisma.mediaAsset.count({ where: { assetGroupId: g } })) + 1 : 1;
    return ctx.prisma.mediaAsset.create({
      data: {
        id,
        workspaceId: ws.id,
        contentItemId: itemInternalId,
        assetType: assetType as "IMAGE",
        originalFilename: "f",
        normalizedFilename: "f",
        storageProviderIdentity: "MINIO",
        bucket: "test",
        objectKey: `t/${id}`,
        declaredMimeType: mime,
        declaredSizeBytes: BigInt(10),
        verifiedMimeType: mime,
        verifiedSizeBytes: BigInt(10),
        extension: ".bin",
        assetGroupId: g,
        versionNumber: version,
        status: "ACTIVE",
        visibility: "WORKSPACE_PRIVATE",
        verifiedAt: new Date(),
        createdById,
      },
      select: { publicId: true, assetGroupId: true },
    });
  }

  async function completeMediaJob(ws: Workspace, itemId: string, mediaJobPublicId: string, output: Record<string, unknown>): Promise<void> {
    // Module 7 Phase 7.5 — the CI worker now also runs the MEDIA queue
    // (the render-worker doubles up for the API E2E suite), so the real
    // fake-provider media processor may race this crafted output. Wait
    // for the job to settle first, then unconditionally pin the fixture
    // output — same pattern as completeAiJob's own waitTerminal.
    const deadline = Date.now() + 20_000;
    let job = await ctx.prisma.mediaJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: mediaJobPublicId } });
    while (Date.now() < deadline && !["COMPLETED", "FAILED", "TIMED_OUT"].includes(job.status)) {
      await new Promise((r) => setTimeout(r, 150));
      job = await ctx.prisma.mediaJob.findFirstOrThrow({ where: { workspaceId: ws.id, publicId: mediaJobPublicId } });
    }
    await ctx.prisma.mediaJob.update({ where: { id: job.id }, data: { status: "COMPLETED", outputPayload: output as object, errorCode: null, completedAt: new Date() } });
    if (job.backgroundJobId) await ctx.prisma.backgroundJob.update({ where: { id: job.backgroundJobId }, data: { status: "COMPLETED" } }).catch(() => undefined);
    void itemId;
  }

  async function itemInternal(itemId: string): Promise<{ id: string; createdById: string }> {
    return ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: itemId }, select: { id: true, createdById: true } });
  }

  async function lastMediaJob(ws: Workspace, operation: string): Promise<string> {
    const j = await ctx.prisma.mediaJob.findFirstOrThrow({ where: { workspaceId: ws.id, operation: operation as "TTS" }, orderBy: { createdAt: "desc" } });
    return j.publicId;
  }

  async function cleanup(ws: Workspace): Promise<void> {
    await ctx.prisma.aiJobStep.deleteMany({ where: { aiJob: { workspaceId: ws.id } } });
    await ctx.prisma.aiJob.deleteMany({ where: { workspaceId: ws.id } });
    await ctx.prisma.mediaJob.deleteMany({ where: { workspaceId: ws.id } });
  }

  // ---------------------------------------------------------------

  it("GET routes are pure reads and 200 with data:null-ish shapes before any media work", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const before = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: id }, select: { updatedAt: true } });
    const assets = await request(server()).get(`${base(ws)}/${id}/assets`).set(auth(ws)).expect(200);
    expect(assets.body.data.gate2.passed).toBe(false);
    expect(assets.body.data.gate2.missingScenes.sort()).toEqual(["scene-1", "scene-2"]);
    await request(server()).get(`${base(ws)}/${id}/voice`).set(auth(ws)).expect(200);
    await request(server()).get(`${base(ws)}/${id}/subtitles`).set(auth(ws)).expect(200);
    await request(server()).get(`${base(ws)}/${id}/thumbnail`).set(auth(ws)).expect(200);
    const after = await ctx.prisma.contentItem.findFirstOrThrow({ where: { publicId: id }, select: { updatedAt: true } });
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    await cleanup(ws);
  });

  it("Gate #2: passes ONLY when every current scene has a resolved ACTIVE asset — itemizes the missing ones", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const { id: itemInternalId, createdById } = await itemInternal(id);

    // Generate scene-1 image → craft its completion.
    const g1 = await request(server()).post(`${base(ws)}/${id}/assets/scenes/scene-1/generate-image`).set(auth(ws)).expect(202);
    void g1;
    const job1 = await lastMediaJob(ws, "IMAGE_GENERATE");
    const a1 = await createActiveAsset(ws, itemInternalId, createdById, "IMAGE", "image/png");
    await completeMediaJob(ws, id, job1, { mediaAssetPublicId: a1.publicId, mediaAssetGroupId: a1.assetGroupId, width: 1536, height: 864 });

    let rm = await get(ws, id);
    expect(rm.assets.status).not.toBe("READY");
    expect(rm.assets.missingScenes).toEqual(["scene-2"]);
    expect(rm.reviewGatesUnmet).toContain("assets_available");

    // Attach an uploaded asset to scene-2.
    const a2 = await createActiveAsset(ws, itemInternalId, createdById, "IMAGE", "image/png");
    await request(server()).post(`${base(ws)}/${id}/assets/scenes/scene-2/attach`).set(auth(ws)).send({ mediaAssetPublicId: a2.publicId }).expect(200);

    rm = await get(ws, id);
    expect(rm.assets.status).toBe("READY");
    expect(rm.assets.missingScenes).toEqual([]);
    expect(rm.reviewGatesUnmet).not.toContain("assets_available");
    await cleanup(ws);
  });

  it("Gate #2: a scene image tied to an OBSOLETE scene plan version cannot satisfy the gate after regeneration", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const { id: itemInternalId, createdById } = await itemInternal(id);

    for (const sc of ["scene-1", "scene-2"]) {
      await request(server()).post(`${base(ws)}/${id}/assets/scenes/${sc}/generate-image`).set(auth(ws)).expect(202);
      const job = await lastMediaJob(ws, "IMAGE_GENERATE");
      const a = await createActiveAsset(ws, itemInternalId, createdById, "IMAGE", "image/png");
      await completeMediaJob(ws, id, job, { mediaAssetPublicId: a.publicId, mediaAssetGroupId: a.assetGroupId, width: 1536, height: 864 });
      await get(ws, id);
    }
    expect((await get(ws, id)).assets.status).toBe("READY");

    // Regenerate the scene plan (new scene ids scene-1..scene-3 say).
    const plan = await request(server()).post(`${base(ws)}/${id}/scene-plan`).set(auth(ws)).expect(202);
    await completeAiJob(ws, aiJobId(plan.body.data, "scenePlan"), {
      ...SCENE_PLAN_OUTPUT,
      scenes: [
        ...SCENE_PLAN_OUTPUT.scenes,
        { order: 3, sceneId: "scene-3", scriptSegmentRef: "seg-2", startSeconds: 6, durationSeconds: 3, visualInstruction: "Wide shot of the finished setup.", transition: "cut", assetRequirements: [{ kind: "image", description: "setup", sourceHint: "ai_generated" }] },
      ],
    });
    const rm = await get(ws, id);
    // scene-1/scene-2 assets survived (same ids); scene-3 is unresolved.
    expect(rm.assets.status).not.toBe("READY");
    expect(rm.assets.missingScenes).toEqual(["scene-3"]); // scene-1/scene-2 assets survived (same ids)
    await cleanup(ws);
  });

  it("Gate #3: requires an approved script, a real ACTIVE audio asset, valid duration + word timings — never a COMPLETED job alone", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const { id: itemInternalId, createdById } = await itemInternal(id);

    await request(server()).post(`${base(ws)}/${id}/voice/generate`).set(auth(ws)).send({ voiceProfileId: "en-in-neerja" }).expect(202);
    const voiceJob = await lastMediaJob(ws, "TTS");

    // COMPLETED job but NO real asset yet → gate stays unmet.
    await completeMediaJob(ws, id, voiceJob, { audioAssetPublicId: null });
    let rm = await get(ws, id);
    expect(rm.voice.status).not.toBe("READY");
    expect(rm.reviewGatesUnmet).toContain("voice_generated");

    // Now the real ACTIVE audio + timings.
    const audio = await createActiveAsset(ws, itemInternalId, createdById, "AUDIO", "audio/mpeg");
    const hash = scriptVersionHash(SCRIPT_OUTPUT as never);
    await ctx.prisma.mediaJob.update({
      where: { publicId: voiceJob },
      data: { outputPayload: { audioAssetPublicId: audio.publicId, wordTimingObjectKey: `t/${audio.publicId}.timings.json`, durationMs: 8000, scriptVersionHash: hash, voiceProfileId: "en-in-neerja" } as object },
    });
    rm = await get(ws, id);
    expect(rm.voice.status).toBe("READY");
    expect(rm.voice.audioAssetPublicId).toBe(audio.publicId);
    expect(rm.reviewGatesUnmet).not.toContain("voice_generated");
    await cleanup(ws);
  });

  it("Gate #3: an unknown voice profile is rejected; generating before script approval is rejected", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    // Before approval:
    const create = await request(server()).post(base(ws)).set(auth(ws)).send({ topic: "x", knowledgePackVersionId: packId, targetPlatform: "YOUTUBE_LONG" }).expect(202);
    const earlyId = create.body.data.contentItem.publicId as string;
    await request(server()).post(`${base(ws)}/${earlyId}/voice/generate`).set(auth(ws)).send({ voiceProfileId: "en-in-neerja" }).expect(422);

    const id = await walkToSeoComplete(ws, packId);
    await request(server()).post(`${base(ws)}/${id}/voice/generate`).set(auth(ws)).send({ voiceProfileId: "does-not-exist" }).expect(422);
    await cleanup(ws);
  });

  it("voice regeneration invalidates subtitle freshness; script regeneration transitively invalidates voice + subtitles", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const { id: itemInternalId, createdById } = await itemInternal(id);
    const hash = scriptVersionHash(SCRIPT_OUTPUT as never);

    // Voice ready
    await request(server()).post(`${base(ws)}/${id}/voice/generate`).set(auth(ws)).send({ voiceProfileId: "en-in-neerja" }).expect(202);
    const voiceJob = await lastMediaJob(ws, "TTS");
    const audio = await createActiveAsset(ws, itemInternalId, createdById, "AUDIO", "audio/mpeg");
    await completeMediaJob(ws, id, voiceJob, { audioAssetPublicId: audio.publicId, wordTimingObjectKey: `t/${audio.publicId}.timings.json`, durationMs: 8000, scriptVersionHash: hash, voiceProfileId: "en-in-neerja" });
    expect((await get(ws, id)).voice.status).toBe("READY");

    // Subtitles ready
    await request(server()).post(`${base(ws)}/${id}/subtitles/generate`).set(auth(ws)).expect(202);
    const subJob = await lastMediaJob(ws, "SUBTITLE_GENERATE");
    const srt = await createActiveAsset(ws, itemInternalId, createdById, "SUBTITLE", "application/x-subrip");
    const vtt = await createActiveAsset(ws, itemInternalId, createdById, "SUBTITLE", "text/vtt");
    await completeMediaJob(ws, id, subJob, { srtAssetPublicId: srt.publicId, vttAssetPublicId: vtt.publicId, cueCount: 3, sourceAudioAssetPublicId: audio.publicId });
    expect((await get(ws, id)).subtitles.status).toBe("READY");

    // --- Regenerate voice. Subtitle invalidation is a SYNCHRONOUS state
    // reset inside the generateVoice mutation — asserted off the mutation
    // response itself, never a re-read that races the new TTS job (the CI
    // render-worker consumes the MEDIA queue during this suite).
    const regen = await request(server()).post(`${base(ws)}/${id}/voice/generate`).set(auth(ws)).send({ voiceProfileId: "hi-in-swara" }).expect(202);
    expect(regen.body.data.subtitles.status).not.toBe("READY");
    expect(regen.body.data.subtitles.srtAssetPublicId).toBeNull();

    // Drive the regenerated voice job to a NEW audio asset: the pipeline
    // must adopt it (proving the regen took, not the stale pre-regen
    // READY state), and the subtitles must stay stale (built on the OLD
    // audio).
    const voiceJob2 = await lastMediaJob(ws, "TTS");
    const audio2 = await createActiveAsset(ws, itemInternalId, createdById, "AUDIO", "audio/mpeg");
    await completeMediaJob(ws, id, voiceJob2, { audioAssetPublicId: audio2.publicId, wordTimingObjectKey: `t/${audio2.publicId}.timings.json`, durationMs: 8000, scriptVersionHash: hash, voiceProfileId: "hi-in-swara" });
    let rm = await get(ws, id);
    expect(rm.voice.status).toBe("READY");
    expect(rm.voice.audioAssetPublicId).toBe(audio2.publicId);
    expect(rm.voice.voiceProfileId).toBe("hi-in-swara");
    expect(rm.subtitles.status).not.toBe("READY");

    // --- Regenerate the SCRIPT → voice AND subtitles are transitively
    // invalidated (claimStage("script") — also a synchronous reset, and
    // Gate #1 approval is cleared).
    const scriptRegen = await request(server()).post(`${base(ws)}/${id}/script`).set(auth(ws)).expect(202);
    expect(scriptRegen.body.data.voice.status).not.toBe("READY");
    expect(scriptRegen.body.data.voice.audioAssetPublicId).toBeNull();
    expect(scriptRegen.body.data.subtitles.status).not.toBe("READY");
    expect(scriptRegen.body.data.script.scriptApproved).toBe(false);

    rm = await get(ws, id);
    expect(rm.voice.status).not.toBe("READY");
    expect(rm.subtitles.status).not.toBe("READY");
    expect(rm.reviewGatesUnmet).toEqual(expect.arrayContaining(["script_approved", "voice_generated"]));
    await cleanup(ws);
  });

  it("thumbnail: concept selection validates the index; generating an image needs a selection first; VIDEO_THUMBNAIL_CONCEPT never leaks as a ContentType", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const tc = await request(server()).post(`${base(ws)}/${id}/thumbnail-concepts`).set(auth(ws)).expect(202);
    await completeAiJob(ws, aiJobId(tc.body.data, "thumbnailConcepts"), THUMBNAIL_OUTPUT);
    await get(ws, id);

    await request(server()).post(`${base(ws)}/${id}/thumbnail-image`).set(auth(ws)).expect(422); // no selection
    await request(server()).post(`${base(ws)}/${id}/thumbnail-concepts/select`).set(auth(ws)).send({ conceptIndex: 5 }).expect(422);
    await request(server()).post(`${base(ws)}/${id}/thumbnail-concepts/select`).set(auth(ws)).send({ conceptIndex: 1 }).expect(200);
    await request(server()).post(`${base(ws)}/${id}/thumbnail-image`).set(auth(ws)).expect(202);

    const { id: itemInternalId, createdById } = await itemInternal(id);
    const job = await lastMediaJob(ws, "IMAGE_GENERATE");
    const img = await createActiveAsset(ws, itemInternalId, createdById, "IMAGE", "image/png");
    await completeMediaJob(ws, id, job, { mediaAssetPublicId: img.publicId, mediaAssetGroupId: img.assetGroupId, width: 1536, height: 864 });
    const rm = await get(ws, id);
    expect(rm.thumbnailImage.status).toBe("READY");
    expect(rm.thumbnailImage.selectedConceptIndex).toBe(1);

    // Sanity: VIDEO_THUMBNAIL_CONCEPT is NOT a value of the Prisma ContentType enum.
    const enumVals = await ctx.prisma.$queryRaw<{ enumlabel: string }[]>`SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ContentType'`;
    expect(enumVals.map((r) => r.enumlabel)).not.toContain("VIDEO_THUMBNAIL_CONCEPT");
    await cleanup(ws);
  });

  it("INVARIANT: after Gates #2 AND #3 pass, a naturally-created item STILL cannot submit for review (Gates #4/#5 unimplemented)", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const { id: itemInternalId, createdById } = await itemInternal(id);
    const hash = scriptVersionHash(SCRIPT_OUTPUT as never);

    for (const sc of ["scene-1", "scene-2"]) {
      await request(server()).post(`${base(ws)}/${id}/assets/scenes/${sc}/generate-image`).set(auth(ws)).expect(202);
      const j = await lastMediaJob(ws, "IMAGE_GENERATE");
      const a = await createActiveAsset(ws, itemInternalId, createdById, "IMAGE", "image/png");
      await completeMediaJob(ws, id, j, { mediaAssetPublicId: a.publicId, mediaAssetGroupId: a.assetGroupId, width: 1536, height: 864 });
      await get(ws, id);
    }
    await request(server()).post(`${base(ws)}/${id}/voice/generate`).set(auth(ws)).send({ voiceProfileId: "en-in-neerja" }).expect(202);
    const vJob = await lastMediaJob(ws, "TTS");
    const audio = await createActiveAsset(ws, itemInternalId, createdById, "AUDIO", "audio/mpeg");
    await completeMediaJob(ws, id, vJob, { audioAssetPublicId: audio.publicId, wordTimingObjectKey: `t/${audio.publicId}.timings.json`, durationMs: 8000, scriptVersionHash: hash, voiceProfileId: "en-in-neerja" });

    const rm = await get(ws, id);
    expect(rm.assets.status).toBe("READY");
    expect(rm.voice.status).toBe("READY");
    // Gates #4 and #5 remain.
    expect(rm.reviewGatesUnmet).toEqual(expect.arrayContaining(["rendering_successful", "qa_passed"]));
    expect(rm.canSubmitForReview).toBe(false);

    await request(server()).post(`${base(ws)}/${id}/submit-for-review`).set(auth(ws)).send({}).expect(422);
    await cleanup(ws);
  });

  it("RBAC: media mutations require VIDEO_EDIT (403 without it); reads require VIDEO_VIEW; cross-workspace asset attach is rejected", async () => {
    const ws = await createWorkspace();
    const packId = await createActivePack(ws);
    const id = await walkToSeoComplete(ws, packId);
    const { id: itemInternalId } = await itemInternal(id);

    const viewer = await createActiveUserAndLogin(ctx, "media-viewer");
    await addActiveMemberWithRole(ctx, ws.id, viewer.userId, "SEO Specialist");
    await request(server()).post(`${base(ws)}/${id}/voice/generate`).set(auth(ws, viewer.accessToken)).send({ voiceProfileId: "en-in-neerja" }).expect(403);
    await request(server()).get(`${base(ws)}/${id}/assets`).set(auth(ws, viewer.accessToken)).expect(200);

    // Cross-workspace asset: create a real VIDEO item in another workspace via the API, then try to attach ITS asset here.
    const otherWs = await createWorkspace();
    const otherPack = await createActivePack(otherWs);
    const otherCreate = await request(server()).post(base(otherWs)).set(auth(otherWs)).send({ topic: "other", knowledgePackVersionId: otherPack, targetPlatform: "YOUTUBE_LONG" }).expect(202);
    const otherInternal = await itemInternal(otherCreate.body.data.contentItem.publicId as string);
    const foreign = await createActiveAsset(otherWs, otherInternal.id, otherInternal.createdById, "IMAGE", "image/png");
    await request(server()).post(`${base(ws)}/${id}/assets/scenes/scene-1/attach`).set(auth(ws)).send({ mediaAssetPublicId: foreign.publicId }).expect(422);
    void itemInternalId;
    await cleanup(ws);
  });
});
