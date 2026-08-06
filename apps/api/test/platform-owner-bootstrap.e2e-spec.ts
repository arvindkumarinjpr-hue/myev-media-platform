import { bootstrapE2eApp, teardownE2eApp, uniqueEmail, type E2eApp } from "./helpers/e2e-app";
import { seedPlatformOwner } from "../src/modules/platform-owner/platform-owner.seed";

/**
 * Module 1C mandatory safeguard 3. The partial unique index on
 * users(is_platform_owner) permits at most one ACTIVE owner in the whole
 * database, so this file — uniquely among the e2e suite — has to
 * temporarily clear and later restore the real seeded owner's flag to
 * exercise seedPlatformOwner's full decision table. Runs alphabetically
 * before the other workspace e2e files (jest's default sequencer sorts by
 * path), and jest-e2e.config.js pins maxWorkers to 1 specifically so this
 * file's mutation of global state can never interleave with another file's
 * tests — but the afterAll restoration here is written to be correct
 * regardless of run order.
 */
describe("Platform Owner bootstrap decision table (e2e)", () => {
  let ctx: E2eApp;
  let realOwnerEmail: string | null = null;

  beforeAll(async () => {
    ctx = await bootstrapE2eApp();
    const realOwner = await ctx.prisma.user.findFirst({ where: { isPlatformOwner: true } });
    realOwnerEmail = realOwner?.email ?? null;
    // Clear every is_platform_owner flag in the database for the duration
    // of this file only — restored in afterAll.
    await ctx.prisma.user.updateMany({ where: { isPlatformOwner: true }, data: { isPlatformOwner: false } });
  });

  afterAll(async () => {
    await ctx.prisma.user.updateMany({ where: { isPlatformOwner: true }, data: { isPlatformOwner: false } });
    if (realOwnerEmail) {
      await ctx.prisma.user.updateMany({ where: { email: realOwnerEmail }, data: { isPlatformOwner: true, deletedAt: null } });
    }
    await teardownE2eApp(ctx);
  });

  it("runs the full decision table: first bootstrap, idempotent rerun, second-owner rejection, config mismatch, soft-deleted-owner handling", async () => {
    const email = uniqueEmail("platform-owner-primary");
    const password = "Platform-Owner-Primary-Password-123";

    // 1. First bootstrap — genuinely zero owners anywhere.
    const first = await seedPlatformOwner(ctx.prisma, { email, password, fullName: "Test Platform Owner" });
    expect(first.kind).toBe("created");
    const createdUser = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    expect(createdUser.isPlatformOwner).toBe(true);
    expect(createdUser.status).toBe("ACTIVE");

    const activeOwnersAfterFirst = await ctx.prisma.user.findMany({ where: { isPlatformOwner: true, deletedAt: null } });
    expect(activeOwnersAfterFirst).toHaveLength(1);

    // 2. Idempotent rerun — same config, already correct.
    const rerun = await seedPlatformOwner(ctx.prisma, { email, password, fullName: "Test Platform Owner" });
    expect(rerun.kind).toBe("already_correct");
    const stillOneOwner = await ctx.prisma.user.findMany({ where: { isPlatformOwner: true, deletedAt: null } });
    expect(stillOneOwner).toHaveLength(1);

    // 3. Attempted second Platform Owner, bypassing the seed function
    //    entirely (simulating a bug or manual edit) — rejected by the
    //    partial unique index itself, independent of application logic.
    const anotherUser = await ctx.prisma.user.create({
      data: { email: uniqueEmail("would-be-second-owner"), fullName: "Second", status: "ACTIVE" },
    });
    await expect(ctx.prisma.user.update({ where: { id: anotherUser.id }, data: { isPlatformOwner: true } })).rejects.toThrow();
    await ctx.prisma.user.delete({ where: { id: anotherUser.id } });

    // 4. Configuration mismatch: an active owner exists, but config points elsewhere.
    const mismatchEmail = uniqueEmail("different-configured-owner");
    await expect(
      seedPlatformOwner(ctx.prisma, { email: mismatchEmail, password: "Whatever-Password-123", fullName: "Nope" }),
    ).rejects.toThrow(/refuses|Refusing|FATAL/i);
    // The original owner is untouched.
    const stillOriginal = await ctx.prisma.user.findMany({ where: { isPlatformOwner: true, deletedAt: null } });
    expect(stillOriginal).toHaveLength(1);
    expect(stillOriginal[0].email).toBe(email);

    // 5. Soft-deleted Platform Owner handling: never auto-replaced, even
    //    with the exact same configured identity.
    await ctx.prisma.user.update({ where: { id: createdUser.id }, data: { deletedAt: new Date() } });
    await expect(seedPlatformOwner(ctx.prisma, { email, password, fullName: "Test Platform Owner" })).rejects.toThrow(
      /soft-deleted/i,
    );
    // Restore for the next test.
    await ctx.prisma.user.update({ where: { id: createdUser.id }, data: { deletedAt: null, isPlatformOwner: false } });
  });

  it(
    "two concurrent first-bootstrap attempts: exactly one Platform Owner exists, both resolve deterministically, no silent transfer",
    async () => {
      // Fully clean slate — no user has ever held the flag. Child rows
      // first (user_password_history has no cascade), then the user.
      const priorTestUsers = await ctx.prisma.user.findMany({
        where: { email: { contains: "e2e-1c-platform-owner" } },
        select: { id: true },
      });
      const priorTestUserIds = priorTestUsers.map((u) => u.id);
      await ctx.prisma.userPasswordHistory.deleteMany({ where: { userId: { in: priorTestUserIds } } });
      await ctx.prisma.user.deleteMany({ where: { id: { in: priorTestUserIds } } });
      const remaining = await ctx.prisma.user.findMany({ where: { isPlatformOwner: true } });
      expect(remaining).toHaveLength(0);

      const email = uniqueEmail("platform-owner-concurrent");
      const password = "Platform-Owner-Concurrent-Password-123";
      const config = { email, password, fullName: "Concurrent Owner" };

      const [resultA, resultB] = await Promise.all([
        seedPlatformOwner(ctx.prisma, config),
        seedPlatformOwner(ctx.prisma, config),
      ]);

      // Both calls resolve without throwing — the advisory lock serializes
      // them, and since both target the SAME configured identity, the
      // second sees "already correct" rather than a conflict.
      expect(["created", "already_correct"]).toContain(resultA.kind);
      expect(["created", "already_correct"]).toContain(resultB.kind);
      expect([resultA.kind, resultB.kind].sort()).toEqual(["already_correct", "created"]);

      const owners = await ctx.prisma.user.findMany({ where: { isPlatformOwner: true, deletedAt: null } });
      expect(owners).toHaveLength(1);
      expect(owners[0].email).toBe(email);
    },
    15_000,
  );
});
