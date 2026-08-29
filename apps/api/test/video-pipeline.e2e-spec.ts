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

  return { ctx, server, auth, base, contentItemsBase, createWorkspace, createActivePack, createVideo, addMember };
}

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
    const stages = d.stages as Record<string, { status: string }>;
    expect(Object.keys(stages).sort()).toEqual(["assets", "brief", "qa", "render", "scenePlan", "script", "seo", "subtitles", "voice"]);
    expect(stages.brief.status).toBe("PENDING");
    expect(stages.render.status).toBe("PENDING");
    expect(stages.qa.status).toBe("PENDING");
    expect(d.currentStage).toBe("BRIEF");
    expect(d.publishReady).toBe(false);
    expect(d.reviewGatesUnmet).toEqual(["script_approved", "assets_available", "voice_generated", "rendering_successful", "qa_passed", "seo_complete"]);
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
