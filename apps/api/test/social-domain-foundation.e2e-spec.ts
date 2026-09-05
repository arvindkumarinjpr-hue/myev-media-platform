import { randomUUID } from "crypto";
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
import { seedRbac } from "../src/modules/rbac/rbac.seed";
import { PERMISSIONS } from "../src/modules/rbac/permissions.constants";

/**
 * Module 10 Phase 10.1 — Social Media Domain + Persistence Foundation.
 * No generation/review API exists yet (Part M) — these tests prove the
 * two things Phase 10.1 actually ships: (1) SOCIAL_POST is a real,
 * RBAC-gated, queryable content type end to end via the generic content
 * lifecycle, and its generic-route review seal is real protection from
 * day one; (2) the social_posts schema's own invariants (1:1, workspace-
 * safe source FK) hold under real Postgres constraints. Source-item and
 * SOCIAL_POST content items are constructed directly via Prisma (the
 * same established test-fixture technique publishing-publications.e2e-
 * spec.ts's own createApprovedBlog() already uses) rather than through
 * POST /content-items, since Phase 10.1 deliberately does not implement
 * real caption generation yet (see the Phase 10.1 completion report's
 * ContentVersion-body finding) — these fixtures are test data, not
 * product-facing generated content.
 */
describe("Social Media domain + persistence foundation (e2e)", () => {
  let ctx: E2eApp;
  let ownerToken: string;
  let ownerUserId: string;
  let ws: { id: string; publicId: string };

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const owner = await loginAsPlatformOwner(ctx);
    ownerToken = owner.accessToken;
    ownerUserId = (await ctx.prisma.user.findUniqueOrThrow({ where: { publicId: owner.publicId } })).id;
    const created = await createWorkspaceAsOwner(ctx, ownerToken);
    const row = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: created.publicId }, select: { id: true } });
    ws = { id: row.id, publicId: created.publicId };
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  function auth(token: string, workspacePublicId = ws.publicId) {
    return { Authorization: `Bearer ${token}`, "X-Workspace-Id": workspacePublicId };
  }

  /**
   * Direct-Prisma fixture — see file doc comment for why this bypasses
   * POST /content-items. All 3 steps run inside one $transaction, same
   * as ContentItemsService.create() itself — content_items has a
   * deferred constraint trigger requiring a non-null currentVersionId
   * "at commit", which fires per-call (not just at the end of the test)
   * if these three writes aren't grouped into one transaction.
   */
  async function createContentItem(overrides: { contentType: "BLOG" | "VIDEO" | "SOCIAL_POST"; status: string; title?: string }): Promise<{ id: string; publicId: string }> {
    return createContentItemInWorkspace(ws.id, overrides);
  }

  async function createContentItemInWorkspace(
    workspaceId: string,
    overrides: { contentType: "BLOG" | "VIDEO" | "SOCIAL_POST"; status: string; title?: string },
  ): Promise<{ id: string; publicId: string }> {
    const id = randomUUID();
    const publicId = randomUUID();
    const versionId = randomUUID();
    await ctx.prisma.$transaction(async (tx) => {
      await tx.contentItem.create({
        data: { id, publicId, workspaceId, contentType: overrides.contentType, title: overrides.title ?? "Fixture", status: "DRAFT", createdById: ownerUserId },
      });
      await tx.contentVersion.create({
        data: { id: versionId, publicId: randomUUID(), contentItemId: id, versionNumber: 1, body: { content: "fixture" }, createdById: ownerUserId },
      });
      await tx.contentItem.update({ where: { id }, data: { currentVersionId: versionId, status: overrides.status as never } });
    });
    return { id, publicId };
  }

  describe("SOCIAL_POST recognized as a real, RBAC-gated content type (Part K #1, #5, #6)", () => {
    it("Owner (SOCIAL_VIEW) can query ?contentType=SOCIAL_POST — 200, not rejected as unsupported", async () => {
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/content-items?contentType=SOCIAL_POST`).set(auth(ownerToken)).expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it("SHORT/REEL/NEWSLETTER remain unsupported even for the Owner — 200 with an empty result, never treated as a real type", async () => {
      for (const contentType of ["SHORT", "REEL", "NEWSLETTER"]) {
        const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/content-items?contentType=${contentType}`).set(auth(ownerToken)).expect(200);
        expect(res.body.data).toEqual([]);
      }
    });

    it("a member holding SEO Specialist (has SOCIAL_VIEW per the frozen role matrix) can query SOCIAL_POST — 200", async () => {
      const user = await createActiveUserAndLogin(ctx, "seo-specialist");
      await addActiveMemberWithRole(ctx, ws.id, user.userId, "SEO Specialist");
      await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/content-items?contentType=SOCIAL_POST`).set(auth(user.accessToken)).expect(200);
    });

    it("a member holding Video Editor (has NO SOCIAL_VIEW) querying SOCIAL_POST is enumeration-safely narrowed to empty, not shown a leak", async () => {
      const user = await createActiveUserAndLogin(ctx, "video-editor");
      await addActiveMemberWithRole(ctx, ws.id, user.userId, "Video Editor");
      const res = await request(ctx.app.getHttpServer()).get(`/api/v1/workspaces/${ws.publicId}/content-items?contentType=SOCIAL_POST`).set(auth(user.accessToken)).expect(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe("Generic lifecycle bypass protection (Part F, Part K #16)", () => {
    it("a SOCIAL_POST item cannot enter REVIEW through the generic content-items route — 409, directed to Module 10's own (not-yet-built) pipeline", async () => {
      const item = await createContentItem({ contentType: "SOCIAL_POST", status: "IN_PROGRESS" });
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`)
        .set(auth(ownerToken))
        .send({})
        .expect(409);
      expect(res.body.code).toBe("CONTENT_ITEM_SOCIAL_REVIEW_VIA_PIPELINE");

      const row = await ctx.prisma.contentItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(row.status).toBe("IN_PROGRESS");
    });

    it("BLOG's own existing seal is unaffected by the SOCIAL_POST seal addition", async () => {
      const item = await createContentItem({ contentType: "BLOG", status: "IN_PROGRESS" });
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/content-items/${item.publicId}/submit-for-review`)
        .set(auth(ownerToken))
        .send({})
        .expect(409);
      expect(res.body.code).toBe("CONTENT_ITEM_BLOG_REVIEW_VIA_PIPELINE");
    });
  });

  describe("social_posts schema invariants (Part D, Part K #14, #15)", () => {
    it("enforces ContentItem <-> SocialPost 1:1 — a second SocialPost row for the same contentItemId is rejected", async () => {
      const source = await createContentItem({ contentType: "BLOG", status: "APPROVED" });
      const socialItem = await createContentItem({ contentType: "SOCIAL_POST", status: "DRAFT" });
      await ctx.prisma.socialPost.create({
        data: { id: randomUUID(), publicId: randomUUID(), workspaceId: ws.id, contentItemId: socialItem.id, sourceContentItemId: source.id, platform: "FACEBOOK" },
      });

      await expect(
        ctx.prisma.socialPost.create({
          data: { id: randomUUID(), publicId: randomUUID(), workspaceId: ws.id, contentItemId: socialItem.id, sourceContentItemId: source.id, platform: "INSTAGRAM" },
        }),
      ).rejects.toThrow();
    });

    it("enforces the workspace-safe source FK — a source content item from a different workspace is rejected", async () => {
      const otherWs = await createWorkspaceAsOwner(ctx, ownerToken);
      const otherWsRow = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: otherWs.publicId }, select: { id: true } });
      const otherWorkspaceSource = await createContentItemInWorkspace(otherWsRow.id, { contentType: "BLOG", status: "APPROVED", title: "Other workspace source" });
      const socialItem = await createContentItem({ contentType: "SOCIAL_POST", status: "DRAFT" });

      await expect(
        ctx.prisma.socialPost.create({
          data: { id: randomUUID(), publicId: randomUUID(), workspaceId: ws.id, contentItemId: socialItem.id, sourceContentItemId: otherWorkspaceSource.id, platform: "FACEBOOK" },
        }),
      ).rejects.toThrow();
    });

    it("enforces the workspace-safe contentItemId FK the identical way — a contentItemId from a different workspace is rejected", async () => {
      const source = await createContentItem({ contentType: "VIDEO", status: "APPROVED" });
      const otherWs = await createWorkspaceAsOwner(ctx, ownerToken);
      const otherWsRow = await ctx.prisma.workspace.findUniqueOrThrow({ where: { publicId: otherWs.publicId }, select: { id: true } });
      const otherWorkspaceItem = await createContentItemInWorkspace(otherWsRow.id, { contentType: "SOCIAL_POST", status: "DRAFT", title: "Other workspace social item" });

      await expect(
        ctx.prisma.socialPost.create({
          data: { id: randomUUID(), publicId: randomUUID(), workspaceId: ws.id, contentItemId: otherWorkspaceItem.id, sourceContentItemId: source.id, platform: "FACEBOOK" },
        }),
      ).rejects.toThrow();
    });

    it("a real Approved Video can be the source of a real Facebook social post row — the happy path the schema exists to support", async () => {
      const source = await createContentItem({ contentType: "VIDEO", status: "APPROVED" });
      const socialItem = await createContentItem({ contentType: "SOCIAL_POST", status: "DRAFT" });
      const row = await ctx.prisma.socialPost.create({
        data: { id: randomUUID(), publicId: randomUUID(), workspaceId: ws.id, contentItemId: socialItem.id, sourceContentItemId: source.id, platform: "FACEBOOK" },
      });
      expect(row.platform).toBe("FACEBOOK");
      expect(row.sourceContentItemId).toBe(source.id);
    });
  });

  describe("RBAC seed idempotency (Part I, Part K #20)", () => {
    it("running seedRbac() again after the 4 new SOCIAL_* permissions exist changes nothing — same permission/role/role_permission row counts, same SOCIAL_* role assignments", async () => {
      const before = {
        permissions: await ctx.prisma.permission.count(),
        roles: await ctx.prisma.role.count(),
        rolePermissions: await ctx.prisma.rolePermission.count(),
      };

      await seedRbac(ctx.prisma);

      const after = {
        permissions: await ctx.prisma.permission.count(),
        roles: await ctx.prisma.role.count(),
        rolePermissions: await ctx.prisma.rolePermission.count(),
      };
      expect(after).toEqual(before);

      const socialCreatePermission = await ctx.prisma.permission.findUniqueOrThrow({ where: { constant: PERMISSIONS.SOCIAL_CREATE } });
      const rolesWithSocialCreate = await ctx.prisma.rolePermission.findMany({ where: { permissionId: socialCreatePermission.id }, include: { role: true } });
      expect(rolesWithSocialCreate.map((rp) => rp.role.name).sort()).toEqual(["Administrator", "Content Manager", "Content Writer", "Owner"].sort());
    });
  });
});
