import * as argon2 from "argon2";
import { PrismaClient } from "../generated/prisma";
import { seedRbac } from "../src/modules/rbac/rbac.seed";

/**
 * Module 1B.1 Engineering Plan §18 decision #1: there is no HTTP endpoint
 * for user creation in Module 1B.1 — an Owner/Admin-gated endpoint is
 * deferred to Module 1C, once workspace-scoped Admin permission checks
 * are real. The very first user (who invites everyone else, once 1C
 * ships) can only be created here, directly in the database, as a
 * deliberate one-time bootstrap exception — created ACTIVE, not via the
 * PENDING_ACTIVATION/token flow, since there is no existing Admin to send
 * that invitation.
 */
async function seedBootstrapOwner(prisma: PrismaClient): Promise<void> {
  const email = (process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com").toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Bootstrap owner already exists (${email}) — skipping.`);
    return;
  }

  const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
  if (!password) {
    console.log("BOOTSTRAP_OWNER_PASSWORD not set — skipping bootstrap owner creation.");
    return;
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const user = await prisma.user.create({
    data: {
      email,
      fullName: process.env.BOOTSTRAP_OWNER_NAME ?? "Platform Owner",
      status: "ACTIVE",
      passwordHash,
      activatedAt: new Date(),
    },
  });
  await prisma.userPasswordHistory.create({ data: { userId: user.id, passwordHash } });

  console.log(`Bootstrap owner created: ${email}`);
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    await seedRbac(prisma);
    console.log("RBAC catalog seeded (roles, permissions, role_permissions).");
    await seedBootstrapOwner(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exitCode = 1;
});
