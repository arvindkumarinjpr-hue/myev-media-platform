import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import cookieParser from "cookie-parser";
import Redis from "ioredis";
import request from "supertest";
import { AppModule } from "../../src/app.module";
import { PrismaService } from "../../src/prisma/prisma.service";
import { PasswordHashService } from "../../src/common/crypto/password-hash.service";

export const TEST_EMAIL_PREFIX = "e2e-1c-";

export function uniqueEmail(label: string): string {
  return `${TEST_EMAIL_PREFIX}${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

export function uniqueSlug(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export interface E2eApp {
  app: INestApplication;
  prisma: PrismaService;
  passwordHashService: PasswordHashService;
  redis: Redis;
}

export async function bootstrapE2eApp(): Promise<E2eApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.init();

  const prisma = app.get(PrismaService);
  const passwordHashService = app.get(PasswordHashService);
  const redis = new Redis(process.env.REDIS_URL ?? "redis://redis:6379");

  return { app, prisma, passwordHashService, redis };
}

export async function teardownE2eApp({ app, redis, prisma }: E2eApp): Promise<void> {
  await redis.quit();
  const testUsers = await prisma.user.findMany({ where: { email: { startsWith: TEST_EMAIL_PREFIX } }, select: { id: true } });
  const testUserIds = testUsers.map((u) => u.id);

  // Workspaces created by a test user OR whose ownership was later
  // transferred TO one (Module 1C's own ownership-transfer tests do
  // exactly that) — workspaces.owner_id is RESTRICT, so any workspace a
  // test user currently owns must be cleaned up before that user can be
  // deleted, regardless of who originally created it.
  const testWorkspaces = await prisma.workspace.findMany({
    where: { OR: [{ createdById: { in: testUserIds } }, { ownerId: { in: testUserIds } }] },
    select: { id: true },
  });
  const testWorkspaceIds = testWorkspaces.map((w) => w.id);

  // The workspace/project <-> slug-reservation composite FKs are deferred
  // specifically so their two sides can be written in either order within
  // ONE transaction (Module 1C Engineering Plan §1) — that cuts both ways:
  // deleting a workspace/project and its reservation ALSO has to happen in
  // one transaction, or Postgres checks the (now-broken) constraint at the
  // end of whichever single auto-committing statement ran first. Caught
  // live: deleting workspace_slug_reservations before its workspace (or
  // vice versa) as separate statements violates workspaces_slug_reservation_fkey.
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: testUserIds } }, { workspaceId: { in: testWorkspaceIds } }] } });
    await tx.workspaceInvitation.deleteMany({ where: { workspaceId: { in: testWorkspaceIds } } });
    await tx.projectSlugReservation.deleteMany({ where: { workspaceId: { in: testWorkspaceIds } } });
    await tx.project.deleteMany({ where: { workspaceId: { in: testWorkspaceIds } } });
    await tx.workspaceMember.deleteMany({ where: { OR: [{ userId: { in: testUserIds } }, { workspaceId: { in: testWorkspaceIds } }] } });
    await tx.workspaceSlugReservation.deleteMany({ where: { workspaceId: { in: testWorkspaceIds } } });
    await tx.workspace.deleteMany({ where: { id: { in: testWorkspaceIds } } });
  });
  await prisma.userActionToken.deleteMany({ where: { userId: { in: testUserIds } } });
  await prisma.userPasswordHistory.deleteMany({ where: { userId: { in: testUserIds } } });
  await prisma.userSession.deleteMany({ where: { userId: { in: testUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
  await app.close();
}

/** Creates an ACTIVE, non-Platform-Owner test user directly (bypassing HTTP) and logs them in. */
export async function createActiveUserAndLogin(
  ctx: E2eApp,
  label: string,
  password = "A-Valid-Password-123",
): Promise<{ userId: string; publicId: string; email: string; accessToken: string }> {
  const email = uniqueEmail(label);
  const passwordHash = await ctx.passwordHashService.hash(password);
  const user = await ctx.prisma.user.create({
    data: { email, fullName: `E2E ${label}`, status: "ACTIVE", passwordHash },
  });
  await ctx.prisma.userPasswordHistory.create({ data: { userId: user.id, passwordHash } });

  const res = await request(ctx.app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
  return { userId: user.id, publicId: user.publicId, email, accessToken: res.body.data.access_token as string };
}

/**
 * The partial unique index on users(is_platform_owner) permits at most one
 * ACTIVE Platform Owner in the whole database — tests cannot mint their
 * own fixture owner alongside whatever the seed script already created.
 * Instead, log in as the real one (same env vars the seed script itself
 * reads), exactly as any real client would.
 */
export async function loginAsPlatformOwner(ctx: E2eApp): Promise<{ accessToken: string; publicId: string; email: string }> {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com";
  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!password) {
    throw new Error("BOOTSTRAP_OWNER_PASSWORD must be set for e2e tests that act as the Platform Owner.");
  }
  const res = await request(ctx.app.getHttpServer()).post("/api/v1/auth/login").send({ email, password }).expect(200);
  return { accessToken: res.body.data.access_token as string, publicId: res.body.data.user.publicId as string, email };
}

export async function createWorkspaceAsOwner(
  ctx: E2eApp,
  ownerAccessToken: string,
  overrides: Partial<{ name: string; slug: string }> = {},
): Promise<{ publicId: string; slug: string; name: string }> {
  const slug = overrides.slug ?? uniqueSlug("ws");
  const name = overrides.name ?? `Workspace ${slug}`;
  const res = await request(ctx.app.getHttpServer())
    .post("/api/v1/workspaces")
    .set("Authorization", `Bearer ${ownerAccessToken}`)
    .send({ name, slug })
    .expect(201);
  return res.body.data as { publicId: string; slug: string; name: string };
}

export function extractToken(url: string): string {
  // \S+ (non-whitespace), not [^&]+ — these are plain-text email bodies
  // with a single query param and no trailing &, so a negated-& class
  // happily matches straight through the newline into the rest of the
  // email text, producing a "token" that's actually "<realtoken>\n\nThis
  // activates..." and hashes to nothing the server ever stored. Caught via
  // a live 400 AUTH_RESET_TOKEN_INVALID on a plain, non-concurrent,
  // single-user flow — the token in the debug-printed email body was
  // visibly correct, which is what pointed at extraction, not the server.
  const match = url.match(/token=(\S+)/);
  if (!match) throw new Error(`No token found in URL: ${url}`);
  return match[1];
}

/**
 * Polls Mailpit for the newest message to `recipient`, retrying briefly —
 * a message sent by the request that just resolved is not always
 * immediately visible in Mailpit's list API, and without this retry two
 * emails sent in quick succession to the same recipient (invite, then
 * activation) can race: the second fetch finds the still-latest-indexed
 * first email instead of the one that was actually just sent.
 */
export async function getLatestEmailFor(recipient: string, sinceMessageId?: string): Promise<{ subject: string; body: string; id: string }> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const listRes = await fetch(`http://mailpit:8025/api/v1/messages?limit=25`);
    const list = (await listRes.json()) as { messages: Array<{ ID: string; To: Array<{ Address: string }>; Subject: string }> };
    const match = list.messages.find((m) => m.To.some((to) => to.Address === recipient) && m.ID !== sinceMessageId);
    if (match) {
      const detailRes = await fetch(`http://mailpit:8025/api/v1/message/${match.ID}`);
      const detail = (await detailRes.json()) as { Text: string; Subject: string };
      return { subject: detail.Subject, body: detail.Text, id: match.ID };
    }
    if (Date.now() > deadline) {
      throw new Error(`No new email found for ${recipient} within timeout (excluding message ${sinceMessageId ?? "none"}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export { request };
