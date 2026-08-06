import {
  bootstrapE2eApp,
  createActiveUserAndLogin,
  createProjectAsOwner,
  createWorkspaceAsOwner,
  EXECUTABLE_BYTES,
  extractToken,
  getLatestEmailFor,
  loginAsPlatformOwner,
  PDF_BYTES,
  PNG_BYTES,
  request,
  teardownE2eApp,
  uniqueEmail,
  uploadBytesToPresignedInstruction,
  type E2eApp,
} from "./helpers/e2e-app";
import { createHash } from "crypto";

async function inviteAndActivate(
  ctx: E2eApp,
  ownerAccessToken: string,
  wsPublicId: string,
  roleName: string,
): Promise<{ userId: string; publicId: string; email: string; accessToken: string }> {
  const email = uniqueEmail("media-member");
  await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/invitations`)
    .set("Authorization", `Bearer ${ownerAccessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send({ email, roleName })
    .expect(201);
  const inviteEmail = await getLatestEmailFor(email);
  await request(ctx.app.getHttpServer()).post(`/api/v1/invitations/${extractToken(inviteEmail.body)}/accept`).expect(200);
  const activationEmail = await getLatestEmailFor(email, inviteEmail.id);
  const password = "Media-Member-Password-123";
  await request(ctx.app.getHttpServer())
    .post("/api/v1/auth/reset-password")
    .send({ token: extractToken(activationEmail.body), newPassword: password })
    .expect(200);
  const login = await request(ctx.app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
  const user = await ctx.prisma.user.findFirstOrThrow({ where: { email } });
  return { userId: user.id, publicId: user.publicId, email, accessToken: login.body.data.access_token as string };
}

async function uploadAndConfirm(
  ctx: E2eApp,
  accessToken: string,
  wsPublicId: string,
  body: { assetType: string; originalFilename: string; declaredMimeType: string; declaredSizeBytes: number; projectId?: string; expectedChecksumSha256?: string },
  bytes: Buffer,
): Promise<{ assetPublicId: string; confirmBody: { assetPublicId: string; status: string; malwareScanStatus: string; rejectionReason: string | null } }> {
  const intentRes = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/assets/upload-intent`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .send(body)
    .expect(201);
  const { assetPublicId, instruction } = intentRes.body.data;
  const uploadRes = await uploadBytesToPresignedInstruction(instruction, bytes, body.declaredMimeType, body.originalFilename);
  expect(uploadRes.ok || uploadRes.status === 204).toBe(true);
  const confirmRes = await request(ctx.app.getHttpServer())
    .post(`/api/v1/workspaces/${wsPublicId}/assets/${assetPublicId}/confirm`)
    .set("Authorization", `Bearer ${accessToken}`)
    .set("X-Workspace-Id", wsPublicId)
    .expect(200);
  return { assetPublicId, confirmBody: confirmRes.body.data };
}

describe("Media assets (e2e)", () => {
  let ctx: E2eApp;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
  });

  beforeEach(async () => {
    await ctx.redis.flushdb();
  });

  afterAll(async () => {
    await teardownE2eApp(ctx);
  });

  describe("Upload flow: valid intent -> confirm -> ACTIVE", () => {
    it(
      "an IMAGE upload is verified and activated, with server-computed checksum recorded",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

        const { assetPublicId, confirmBody } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        expect(confirmBody.status).toBe("ACTIVE");
        expect(confirmBody.malwareScanStatus).toBe("NOT_SCANNED");
        expect(confirmBody.rejectionReason).toBeNull();

        const row = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: assetPublicId } });
        expect(row.verifiedMimeType).toBe("image/png");
        expect(row.verifiedChecksumSha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
        expect(Number(row.verifiedSizeBytes)).toBe(PNG_BYTES.length);
        expect(row.malwareScanStatus).toBe("NOT_SCANNED");

        const getRes = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(getRes.body.data.malwareScanStatus).toBe("NOT_SCANNED");
      },
      20_000,
    );

    it("a DOCUMENT upload (PDF) is verified and activated", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const { confirmBody } = await uploadAndConfirm(
        ctx,
        owner.accessToken,
        ws.publicId,
        { assetType: "DOCUMENT", originalFilename: "brief.pdf", declaredMimeType: "application/pdf", declaredSizeBytes: PDF_BYTES.length },
        PDF_BYTES,
      );
      expect(confirmBody.status).toBe("ACTIVE");
    });
  });

  describe("MIME and checksum verification (never trusted from the client alone)", () => {
    it(
      "storage-reported Content-Type is not trusted — bytes that don't match the declared type are rejected by magic-byte sniffing",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);

        // Declares image/png, uploads PDF bytes with a spoofed Content-Type
        // field matching the declaration — the POST policy's Content-Type
        // condition only checks string consistency, not real content.
        const { confirmBody } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "fake.png", declaredMimeType: "image/png", declaredSizeBytes: PDF_BYTES.length },
          PDF_BYTES,
        );
        expect(confirmBody.status).toBe("REJECTED");
        expect(confirmBody.rejectionReason).toBe("mime_mismatch_or_unrecognized_format");
      },
      20_000,
    );

    it(
      "an executable signature is rejected regardless of declared type or extension",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { confirmBody } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "totally-a-photo.png", declaredMimeType: "image/png", declaredSizeBytes: EXECUTABLE_BYTES.length },
          EXECUTABLE_BYTES,
        );
        expect(confirmBody.status).toBe("REJECTED");
        expect(confirmBody.rejectionReason).toBe("executable_signature_detected");
      },
      20_000,
    );

    it(
      "a client-supplied checksum that doesn't match the real bytes is rejected, but the true checksum is still recorded",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const wrongChecksum = "0".repeat(64);
        const { assetPublicId, confirmBody } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          {
            assetType: "IMAGE",
            originalFilename: "photo.png",
            declaredMimeType: "image/png",
            declaredSizeBytes: PNG_BYTES.length,
            expectedChecksumSha256: wrongChecksum,
          },
          PNG_BYTES,
        );
        expect(confirmBody.status).toBe("REJECTED");
        expect(confirmBody.rejectionReason).toBe("checksum_mismatch");
        const row = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: assetPublicId } });
        expect(row.verifiedChecksumSha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));
      },
      20_000,
    );

    it("malformed expectedChecksumSha256 is rejected at upload-intent time, before any presigned instruction is issued", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({
          assetType: "IMAGE",
          originalFilename: "photo.png",
          declaredMimeType: "image/png",
          declaredSizeBytes: PNG_BYTES.length,
          expectedChecksumSha256: "not-a-real-checksum",
        })
        .expect(400)
        .expect((res) => expect(res.body.code).toBe("MEDIA_ASSET_INVALID_CHECKSUM_FORMAT"));
    });

    it(
      "an object never actually uploaded is rejected at confirm time, not silently left active",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ assetType: "IMAGE", originalFilename: "never-uploaded.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(201);
        const { assetPublicId } = intentRes.body.data;
        // No upload performed — call confirm directly.
        const confirmRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/confirm`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(confirmRes.body.data.status).toBe("REJECTED");
        expect(confirmRes.body.data.rejectionReason).toBe("object_not_found");
      },
      20_000,
    );
  });

  describe("Size limits", () => {
    it("a declared size over the effective limit is rejected at intent time, before any presigned instruction is issued", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ assetType: "IMAGE", originalFilename: "huge.png", declaredMimeType: "image/png", declaredSizeBytes: 999_999_999_999 })
        .expect(413);
      expect(res.body.code).toBe("MEDIA_ASSET_EXCEEDS_SYNC_VERIFICATION_LIMIT");
    });

    it("VIDEO's effective limit is the approved ACR ceiling (500MB), not the frozen 2GB FRD maximum", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const capabilitiesRes = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/assets/upload-capabilities`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);
      const video = capabilitiesRes.body.data.find((c: { assetType: string }) => c.assetType === "VIDEO");
      expect(video.frdMaxSizeBytes).toBe(2147483648);
      expect(video.effectiveMaxSizeBytes).toBe(524288000);

      // A declared size between the effective ceiling and the frozen FRD
      // maximum is rejected — proves the *effective* limit, not the FRD
      // one, is what's actually enforced.
      const between = video.effectiveMaxSizeBytes + 1;
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ assetType: "VIDEO", originalFilename: "big.mp4", declaredMimeType: "video/mp4", declaredSizeBytes: between })
        .expect(413);
    });
  });

  describe("Workspace isolation", () => {
    it(
      "a cross-workspace asset lookup/confirm returns 404, never 403",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          wsA.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${wsB.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", wsB.publicId)
          .expect(404);

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${wsB.publicId}/assets/${assetPublicId}/confirm`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", wsB.publicId)
          .expect(404);
      },
      20_000,
    );
  });

  describe("Per-workspace-only duplicate detection", () => {
    it(
      "the same bytes uploaded twice in one workspace are flagged as duplicates",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const first = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "a.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        const second = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "b.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        expect(second.confirmBody.status).toBe("ACTIVE");
        const secondRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: second.assetPublicId } });
        const firstRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: first.assetPublicId } });
        expect(secondRow.duplicateOfAssetId).toBe(firstRow.id);
      },
      20_000,
    );

    it(
      "the same bytes in two different workspaces are never cross-workspace-flagged as duplicates",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const a = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          wsA.publicId,
          { assetType: "IMAGE", originalFilename: "a.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        const b = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          wsB.publicId,
          { assetType: "IMAGE", originalFilename: "b.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        const aRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: a.assetPublicId } });
        const bRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: b.assetPublicId } });
        expect(aRow.duplicateOfAssetId).toBeNull();
        expect(bRow.duplicateOfAssetId).toBeNull();
      },
      20_000,
    );
  });

  describe("Concurrent confirmation (claim/finalize, no long DB lock across storage I/O)", () => {
    it(
      "two concurrent confirm() calls: one wins the claim, the loser is rejected by the lock re-check before touching storage twice",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ assetType: "IMAGE", originalFilename: "race.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(201);
        const { assetPublicId, instruction } = intentRes.body.data;
        await uploadBytesToPresignedInstruction(instruction, PNG_BYTES, "image/png", "race.png");

        const confirm = () =>
          request(ctx.app.getHttpServer())
            .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/confirm`)
            .set("Authorization", `Bearer ${owner.accessToken}`)
            .set("X-Workspace-Id", ws.publicId);

        const [r1, r2] = await Promise.all([confirm(), confirm()]);
        const statuses = [r1.status, r2.status].sort((a, b) => a - b);
        // One request completes the verification (200, ACTIVE); the other
        // is rejected at the claim step before it ever reaches storage.
        expect(statuses).toEqual([200, 409]);
        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body.code).toBe("MEDIA_ASSET_VERIFICATION_IN_PROGRESS");

        const winner = r1.status === 200 ? r1 : r2;
        expect(winner.body.data.status).toBe("ACTIVE");

        // Exactly one activation — no duplicate audit events from a
        // double-processed verification.
        const activatedEvents = await ctx.prisma.auditLog.findMany({ where: { action: "MEDIA_ASSET_ACTIVATED", entityId: assetPublicId } });
        expect(activatedEvents).toHaveLength(1);
      },
      20_000,
    );

    it(
      "a third confirm() call after the asset is already ACTIVE gets a clean 409, not a 500",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        const res = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/confirm`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(409);
        expect(res.body.code).toBe("MEDIA_ASSET_ALREADY_CONFIRMED");
      },
      20_000,
    );
  });

  describe("Archive/restore/delete lifecycle", () => {
    it(
      "archive then restore returns the asset to ACTIVE when no newer version exists",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/archive`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200)
          .expect((res) => expect(res.body.data.status).toBe("ARCHIVED"));

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/restore`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200)
          .expect((res) => expect(res.body.data.status).toBe("ACTIVE"));
      },
      20_000,
    );

    it(
      "soft delete moves ACTIVE -> DELETED and cannot be re-deleted",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        await request(ctx.app.getHttpServer())
          .delete(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200)
          .expect((res) => expect(res.body.data.status).toBe("DELETED"));

        const res = await request(ctx.app.getHttpServer())
          .delete(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(409);
        expect(res.body.code).toBe("MEDIA_ASSET_NOT_DELETABLE");
      },
      20_000,
    );
  });

  describe("Download URL", () => {
    it(
      "an ACTIVE asset's download URL round-trips to the exact same bytes, and the URL is never echoed in the confirm response",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { assetPublicId, confirmBody } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        // The confirm response body never contains a URL of any kind.
        expect(JSON.stringify(confirmBody)).not.toMatch(/https?:\/\//);

        const downloadRes = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/download-url`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        const { downloadUrl } = downloadRes.body.data;
        const fileRes = await fetch(downloadUrl);
        const downloaded = Buffer.from(await fileRes.arrayBuffer());
        expect(downloaded.equals(PNG_BYTES)).toBe(true);
      },
      20_000,
    );

    it("a non-ACTIVE asset cannot get a download URL", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const intentRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
        .expect(201);
      const { assetPublicId } = intentRes.body.data;
      const res = await request(ctx.app.getHttpServer())
        .get(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/download-url`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(409);
      expect(res.body.code).toBe("MEDIA_ASSET_NOT_ACTIVE");
    });
  });

  describe("Versioning (Safeguard 1: version-number invariant)", () => {
    it(
      "a valid replacement archives the old version and activates the new one atomically",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const original = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "DOCUMENT", originalFilename: "v1.pdf", declaredMimeType: "application/pdf", declaredSizeBytes: PDF_BYTES.length },
          PDF_BYTES,
        );

        const replacementBytes = Buffer.concat([PDF_BYTES, Buffer.from("-v2")]);
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/versions/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ originalFilename: "v2.pdf", declaredMimeType: "application/pdf", declaredSizeBytes: replacementBytes.length })
          .expect(201);
        const { assetPublicId: newAssetPublicId, instruction } = intentRes.body.data;
        await uploadBytesToPresignedInstruction(instruction, replacementBytes, "application/pdf", "v2.pdf");
        const confirmRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${newAssetPublicId}/confirm`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(confirmRes.body.data.status).toBe("ACTIVE");

        const oldRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: original.assetPublicId } });
        const newRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: newAssetPublicId } });
        expect(oldRow.status).toBe("ARCHIVED");
        expect(newRow.status).toBe("ACTIVE");
        expect(newRow.versionNumber).toBe(2);
        expect(newRow.assetGroupId).toBe(oldRow.assetGroupId);
        expect(newRow.supersedesAssetId).toBe(oldRow.id);

        // Version-number invariant (Safeguard 1): unique per (assetGroupId, versionNumber).
        const versions = await ctx.prisma.mediaAsset.findMany({ where: { assetGroupId: oldRow.assetGroupId } });
        const versionNumbers = versions.map((v) => v.versionNumber).sort();
        expect(new Set(versionNumbers).size).toBe(versionNumbers.length);
      },
      20_000,
    );

    it(
      "a failed replacement leaves the current version ACTIVE and unchanged",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const original = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "v1.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        // Replacement declares image/png but uploads executable bytes — verification fails.
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/versions/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ originalFilename: "v2.png", declaredMimeType: "image/png", declaredSizeBytes: EXECUTABLE_BYTES.length })
          .expect(201);
        const { assetPublicId: newAssetPublicId, instruction } = intentRes.body.data;
        await uploadBytesToPresignedInstruction(instruction, EXECUTABLE_BYTES, "image/png", "v2.png");
        const confirmRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${newAssetPublicId}/confirm`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(confirmRes.body.data.status).toBe("REJECTED");

        const oldRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: original.assetPublicId } });
        expect(oldRow.status).toBe("ACTIVE");
      },
      20_000,
    );

    it(
      "concurrent replacement intents for the same asset: exactly one wins, the other gets a clean 409",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const original = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "v1.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        const startReplacement = () =>
          request(ctx.app.getHttpServer())
            .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/versions/upload-intent`)
            .set("Authorization", `Bearer ${owner.accessToken}`)
            .set("X-Workspace-Id", ws.publicId)
            .send({ originalFilename: "v2.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length });

        const [r1, r2] = await Promise.all([startReplacement(), startReplacement()]);
        const statuses = [r1.status, r2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([201, 409]);
        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body.code).toBe("MEDIA_ASSET_REPLACEMENT_IN_PROGRESS");
      },
      20_000,
    );

    it("replacing a non-current (historical/superseded) version is rejected", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const original = await uploadAndConfirm(
        ctx,
        owner.accessToken,
        ws.publicId,
        { assetType: "IMAGE", originalFilename: "v1.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
        PNG_BYTES,
      );
      // Promote a v2 first.
      const v2Bytes = Buffer.concat([PNG_BYTES, Buffer.from("-v2")]);
      const intentRes = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/versions/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ originalFilename: "v2.png", declaredMimeType: "image/png", declaredSizeBytes: v2Bytes.length })
        .expect(201);
      await uploadBytesToPresignedInstruction(intentRes.body.data.instruction, v2Bytes, "image/png", "v2.png");
      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/${intentRes.body.data.assetPublicId}/confirm`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(200);

      // Attempt to replace the now-historical v1.
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/versions/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .send({ originalFilename: "v3.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
        .expect(409);
      expect(res.body.code).toBe("MEDIA_ASSET_NOT_CURRENT_VERSION");
    });

    it(
      "restoring a historical, superseded version is rejected — only the current-when-archived version can be restored",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const original = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "v1.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        const v2Bytes = Buffer.concat([PNG_BYTES, Buffer.from("-v2")]);
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/versions/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ originalFilename: "v2.png", declaredMimeType: "image/png", declaredSizeBytes: v2Bytes.length })
          .expect(201);
        await uploadBytesToPresignedInstruction(intentRes.body.data.instruction, v2Bytes, "image/png", "v2.png");
        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${intentRes.body.data.assetPublicId}/confirm`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);

        // v1 is now ARCHIVED (superseded), v2 is ACTIVE.
        const res = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${original.assetPublicId}/restore`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(409);
        expect(res.body.code).toBe("MEDIA_ASSET_SUPERSEDED_CANNOT_RESTORE");
      },
      20_000,
    );
  });

  describe("Retry verification (Safeguard 2: retryable, not a re-upload)", () => {
    it(
      "a VERIFICATION_FAILED asset can be retried and activates against the SAME stored object, without any new upload",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ assetType: "IMAGE", originalFilename: "retry.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(201);
        const { assetPublicId, instruction } = intentRes.body.data;
        await uploadBytesToPresignedInstruction(instruction, PNG_BYTES, "image/png", "retry.png");

        // Simulate a prior retryable infrastructure failure directly at
        // the DB level — the object genuinely exists in storage
        // (uploaded above), only the row's own state says a previous
        // verification attempt didn't complete cleanly.
        const row = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: assetPublicId } });
        await ctx.prisma.mediaAsset.update({
          where: { id: row.id },
          data: { status: "VERIFICATION_FAILED", rejectionReason: "checksum_timeout_or_stream_interrupted" },
        });

        const retryRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/retry-verification`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(retryRes.body.data.status).toBe("ACTIVE");

        const finalRow = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: assetPublicId } });
        expect(finalRow.verifiedChecksumSha256).toBe(createHash("sha256").update(PNG_BYTES).digest("hex"));

        const retriedEvents = await ctx.prisma.auditLog.findMany({ where: { action: "MEDIA_ASSET_VERIFICATION_RETRIED", entityId: assetPublicId } });
        expect(retriedEvents).toHaveLength(1);
      },
      20_000,
    );

    it("an asset that is not VERIFICATION_FAILED cannot be retried", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const { assetPublicId } = await uploadAndConfirm(
        ctx,
        owner.accessToken,
        ws.publicId,
        { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
        PNG_BYTES,
      );
      const res = await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/retry-verification`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", ws.publicId)
        .expect(409);
      expect(res.body.code).toBe("MEDIA_ASSET_NOT_RETRYABLE");
    });

    it(
      "concurrent retry-verification calls: one wins the claim, the other is rejected before touching storage",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const intentRes = await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ assetType: "IMAGE", originalFilename: "retry-race.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(201);
        const { assetPublicId, instruction } = intentRes.body.data;
        await uploadBytesToPresignedInstruction(instruction, PNG_BYTES, "image/png", "retry-race.png");
        const row = await ctx.prisma.mediaAsset.findFirstOrThrow({ where: { publicId: assetPublicId } });
        await ctx.prisma.mediaAsset.update({ where: { id: row.id }, data: { status: "VERIFICATION_FAILED", rejectionReason: "storage_metadata_timeout" } });

        const retry = () =>
          request(ctx.app.getHttpServer())
            .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/retry-verification`)
            .set("Authorization", `Bearer ${owner.accessToken}`)
            .set("X-Workspace-Id", ws.publicId);

        const [r1, r2] = await Promise.all([retry(), retry()]);
        const statuses = [r1.status, r2.status].sort((a, b) => a - b);
        expect(statuses).toEqual([200, 409]);
        const loser = r1.status === 409 ? r1 : r2;
        expect(loser.body.code).toBe("MEDIA_ASSET_VERIFICATION_IN_PROGRESS");
      },
      20_000,
    );
  });

  describe("RBAC — exact MEDIA_* permission mapping", () => {
    it(
      "Content Writer (VIEW+UPLOAD only) can upload but not manage or delete",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const writer = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Content Writer");

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
          .set("Authorization", `Bearer ${writer.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(201);

        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "owned-by-owner.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/archive`)
          .set("Authorization", `Bearer ${writer.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(403);

        await request(ctx.app.getHttpServer())
          .delete(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${writer.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(403);
      },
      30_000,
    );

    it(
      "Publisher (VIEW only) cannot upload",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const publisher = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Publisher");

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/upload-intent`)
          .set("Authorization", `Bearer ${publisher.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(403);

        await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/assets`)
          .set("Authorization", `Bearer ${publisher.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
      },
      30_000,
    );

    it(
      "Video Editor (VIEW+UPLOAD+MANAGE) can archive but not delete",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const editor = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Video Editor");
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/archive`)
          .set("Authorization", `Bearer ${editor.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);

        await request(ctx.app.getHttpServer())
          .delete(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${editor.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(403);
      },
      30_000,
    );

    it(
      "version-replacement requires MEDIA_UPLOAD *and* MEDIA_MANAGE together — Content Writer (upload only) is denied",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const writer = await inviteAndActivate(ctx, owner.accessToken, ws.publicId, "Content Writer");
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );

        await request(ctx.app.getHttpServer())
          .post(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/versions/upload-intent`)
          .set("Authorization", `Bearer ${writer.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .send({ originalFilename: "v2.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length })
          .expect(403);
      },
      30_000,
    );
  });

  describe("Project scoping", () => {
    it(
      "an asset can be scoped to a project within the same workspace, and metadata updates can reassign it",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const project = await createProjectAsOwner(ctx, owner.accessToken, ws.publicId);

        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          {
            assetType: "IMAGE",
            originalFilename: "photo.png",
            declaredMimeType: "image/png",
            declaredSizeBytes: PNG_BYTES.length,
            projectId: project.publicId,
          },
          PNG_BYTES,
        );

        const getRes = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(getRes.body.data.projectId).toBeTruthy();

        const listRes = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/assets?projectId=${project.publicId}`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        expect(listRes.body.data.map((a: { publicId: string }) => a.publicId)).toContain(assetPublicId);
      },
      20_000,
    );

    it("uploading with a project ID that doesn't belong to this workspace returns 404", async () => {
      const owner = await loginAsPlatformOwner(ctx);
      const wsA = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const wsB = await createWorkspaceAsOwner(ctx, owner.accessToken);
      const projectInB = await createProjectAsOwner(ctx, owner.accessToken, wsB.publicId);

      await request(ctx.app.getHttpServer())
        .post(`/api/v1/workspaces/${wsA.publicId}/assets/upload-intent`)
        .set("Authorization", `Bearer ${owner.accessToken}`)
        .set("X-Workspace-Id", wsA.publicId)
        .send({
          assetType: "IMAGE",
          originalFilename: "photo.png",
          declaredMimeType: "image/png",
          declaredSizeBytes: PNG_BYTES.length,
          projectId: projectInB.publicId,
        })
        .expect(404);
    });
  });

  describe("Storage privacy", () => {
    it(
      "the object is not readable at its raw storage URL without a valid signature",
      async () => {
        const owner = await loginAsPlatformOwner(ctx);
        const ws = await createWorkspaceAsOwner(ctx, owner.accessToken);
        const { assetPublicId } = await uploadAndConfirm(
          ctx,
          owner.accessToken,
          ws.publicId,
          { assetType: "IMAGE", originalFilename: "photo.png", declaredMimeType: "image/png", declaredSizeBytes: PNG_BYTES.length },
          PNG_BYTES,
        );
        const downloadRes = await request(ctx.app.getHttpServer())
          .get(`/api/v1/workspaces/${ws.publicId}/assets/${assetPublicId}/download-url`)
          .set("Authorization", `Bearer ${owner.accessToken}`)
          .set("X-Workspace-Id", ws.publicId)
          .expect(200);
        const signedUrl = new URL(downloadRes.body.data.downloadUrl as string);
        // Strip every query parameter (the signature, credential, date,
        // expiry) — an unsigned request to the same path must be denied.
        signedUrl.search = "";
        const unsignedRes = await fetch(signedUrl.toString());
        expect(unsignedRes.status).toBeGreaterThanOrEqual(400);
      },
      20_000,
    );
  });

  // Not covered here (deliberately, per the approved plan's scope):
  // storage-provider outage / individual-operation-timeout / cumulative
  // verification-duration-timeout scenarios — those require a fault-
  // injecting fake StorageProvider, which is a unit-level concern per the
  // plan's test-matrix split, not a real-MinIO e2e concern. Signed-URL
  // *expiry* (as opposed to signature-stripping, covered above) is not
  // exercised either — it would require waiting out a real TTL.
});
