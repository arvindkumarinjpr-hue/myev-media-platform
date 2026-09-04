import { randomUUID } from "crypto";
import { Test, type TestingModule } from "@nestjs/testing";
import { PublishingProviderRegistryBuilder, WordPressChannelProvider, startWordPressFixtureServer, type WordPressFixtureServer } from "@myev/shared";
import { PrismaService } from "@myev/worker-core";
import { AppModule } from "../src/app.module";
import { PUBLISHING_PROVIDER_REGISTRY } from "../src/publishing/publishing-provider-registry.module";
import { PublishingCredentialCryptoService } from "../src/publishing/publishing-credential-crypto.service";
import { PublishingExecutionService } from "../src/publishing/publishing-execution.service";

const FIXTURE_BLOG_DRAFT = {
  introduction: "Fixture introduction.",
  bodySections: [{ level: 2, heading: "Fixture Section", content: "Fixture section content." }],
  conclusion: "Fixture conclusion.",
  cta: "Fixture call to action.",
  faqs: [],
};

const FIXTURE_WORDPRESS_APPLICATION_PASSWORD = "abcd 1234 efgh 5678";

/**
 * Module 9 Phase 9.4 — the "Integration" category test (Part Z): proves
 * the real `WordPressChannelProvider` (not the FixturePublishingChannelProvider
 * every other publishing-execution.e2e-spec.ts test uses) working end to
 * end through the existing, unmodified Phase 9.3 execution backbone —
 * PUBLISHING_PROVIDER_REGISTRY is overridden with the real provider
 * class, pointed at a local `startWordPressFixtureServer` instance via
 * `allowLocalTestTarget: true` (never the production default). A separate
 * TestingModule/AppModule bootstrap from publishing-execution.e2e-spec.ts's
 * own (which uses the fixture provider for every other Phase 9.3 test) —
 * PublishingProviderRegistry only allows one provider per channel type,
 * so the real-provider case needs its own module instance.
 */
describe("Worker (e2e) — Module 9 Phase 9.4 WordPress connector, real provider through the full execution backbone", () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let execution: PublishingExecutionService;
  let crypto: PublishingCredentialCryptoService;
  let fixtureServer: WordPressFixtureServer;

  beforeAll(async () => {
    fixtureServer = await startWordPressFixtureServer((req) => {
      // Readiness's own connection-health check calls validateConnection()
      // (GET users/me) before execute() ever reaches publish() — must be
      // handled or the whole attempt fails at readiness, never even
      // reaching the create/reconciliation paths below.
      if (req.path === "/wp-json/wp/v2/users/me" && req.method === "GET") return { status: 200, json: { id: 1, name: "MYEV Bot" } };
      if (req.path.startsWith("/wp-json/wp/v2/posts?search=")) return { status: 200, json: [] }; // no existing post — reconciliation finds nothing.
      if (req.path === "/wp-json/wp/v2/posts" && req.method === "POST") {
        return { status: 201, json: { id: 4242, link: "https://blog.example.invalid/2026/09/fixture-post/" } };
      }
      return { status: 500, json: { message: "unexpected fixture request" } };
    });

    moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PUBLISHING_PROVIDER_REGISTRY)
      .useFactory({
        factory: () => {
          const builder = new PublishingProviderRegistryBuilder();
          builder.register(new WordPressChannelProvider({ allowLocalTestTarget: true }));
          return builder.freeze();
        },
      })
      .compile();
    await moduleRef.init();

    prisma = moduleRef.get(PrismaService);
    execution = moduleRef.get(PublishingExecutionService);
    crypto = moduleRef.get(PublishingCredentialCryptoService);
  });

  afterAll(async () => {
    await moduleRef.close();
    await fixtureServer.close();
  });

  interface Workspace {
    id: string;
    publicId: string;
  }

  async function createTestWorkspace(): Promise<Workspace & { userId: string }> {
    const suffix = randomUUID();
    const user = await prisma.user.create({ data: { email: `publishing-wp-integration-${suffix}@example.invalid`, fullName: "Publishing WordPress Integration Test User", status: "ACTIVE" } });
    const workspace = await prisma.$transaction(async (tx) => {
      const created = await tx.workspace.create({ data: { name: `Publishing WP Integration WS ${suffix}`, slug: `publishing-wp-integration-${suffix}`, ownerId: user.id, createdById: user.id } });
      await tx.workspaceSlugReservation.create({ data: { workspaceId: created.id, slug: created.slug } });
      return created;
    });
    return { id: workspace.id, publicId: workspace.publicId, userId: user.id };
  }

  async function createReadyBlogContentItem(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const suffix = randomUUID();
    const body = { content: "fixture", blogDraft: FIXTURE_BLOG_DRAFT };
    const item = await prisma.$transaction(async (tx) => {
      const created = await tx.contentItem.create({ data: { workspaceId: ws.id, contentType: "BLOG", title: `Ready blog ${suffix}`, status: "APPROVED", createdById: userId } });
      const version = await tx.contentVersion.create({ data: { contentItemId: created.id, versionNumber: 1, body, createdById: userId } });
      return tx.contentItem.update({ where: { id: created.id }, data: { currentVersionId: version.id } });
    });
    await prisma.blogArticle.create({
      data: { workspaceId: ws.id, contentItemId: item.id, metaTitle: "Fixture title", metaDescription: "Fixture description", urlSlug: `fixture-${suffix}`, schemaMarkup: {}, createdById: userId },
    });
    return { id: item.id, publicId: item.publicId };
  }

  async function createWordPressChannelAccount(ws: Workspace, userId: string): Promise<{ id: string; publicId: string }> {
    const encrypted = crypto.encrypt({ siteUrl: fixtureServer.url, username: "myev", applicationPassword: FIXTURE_WORDPRESS_APPLICATION_PASSWORD });
    const credential = await prisma.channelCredential.create({ data: { workspaceId: ws.id, ...encrypted } });
    const account = await prisma.publishingChannelAccount.create({
      data: { workspaceId: ws.id, channelType: "WORDPRESS", displayName: "Fixture WordPress (real provider)", externalAccountId: `ext-${credential.id}`, credentialId: credential.id, connectedById: userId },
    });
    return { id: account.id, publicId: account.publicId };
  }

  async function createQueuedTarget(ws: Workspace, userId: string, contentItemId: string, channelAccountId: string) {
    const publication = await prisma.publication.create({ data: { workspaceId: ws.id, contentItemId, requestedById: userId } });
    return prisma.publicationTarget.create({
      data: { workspaceId: ws.id, publicationId: publication.id, contentItemId, channelAccountId, status: "QUEUED", idempotencyKey: `publish:${publication.publicId}:${randomUUID()}` },
    });
  }

  it("QUEUED -> PUBLISHING -> PUBLISHED against the real WordPressChannelProvider + a local fixture server, external id/url persisted, no secret in PublishAttempt, ContentItem stays APPROVED", async () => {
    const ws = await createTestWorkspace();
    const item = await createReadyBlogContentItem(ws, ws.userId);
    const channel = await createWordPressChannelAccount(ws, ws.userId);
    const target = await createQueuedTarget(ws, ws.userId, item.id, channel.id);

    const outcome = await execution.execute(ws.publicId, target.publicId);
    expect(outcome.kind).toBe("success");
    if (outcome.kind !== "success") return;
    expect(outcome.externalContentId).toBe("4242");
    expect(outcome.externalUrl).toBe("https://blog.example.invalid/2026/09/fixture-post/");

    const updated = await prisma.publicationTarget.findUniqueOrThrow({ where: { id: target.id } });
    expect(updated.status).toBe("PUBLISHED");
    expect(updated.publishedAt).not.toBeNull();
    expect(updated.externalContentId).toBe("4242");
    expect(updated.externalUrl).toBe("https://blog.example.invalid/2026/09/fixture-post/");

    const attempts = await prisma.publishAttempt.findMany({ where: { publicationTargetId: target.id }, orderBy: { occurredAt: "asc" } });
    expect(JSON.stringify(attempts)).not.toContain(FIXTURE_WORDPRESS_APPLICATION_PASSWORD);
    // completeTarget() persists only { externalContentId, externalUrl } —
    // never the WordPress REST response verbatim (Part S).
    const publishedAttempt = attempts.find((a) => a.toStatus === "PUBLISHED");
    expect(Object.keys(publishedAttempt?.detail as Record<string, unknown>).sort()).toEqual(["externalContentId", "externalUrl"]);

    const contentItemAfter = await prisma.contentItem.findUniqueOrThrow({ where: { id: item.id }, select: { status: true } });
    expect(contentItemAfter.status).toBe("APPROVED");

    const createRequest = fixtureServer.requests.find((r) => r.method === "POST");
    expect(createRequest?.authorization).toBe(`Basic ${Buffer.from(`myev:${FIXTURE_WORDPRESS_APPLICATION_PASSWORD}`).toString("base64")}`);
  });
});
