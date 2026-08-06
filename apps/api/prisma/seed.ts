import { PrismaClient } from "../generated/prisma";
import { seedRbac } from "../src/modules/rbac/rbac.seed";
import { seedPlatformOwner } from "../src/modules/platform-owner/platform-owner.seed";

/**
 * Module 1B.1 Engineering Plan §18 decision #1 / Module 1C Engineering Plan
 * §2A′: there is no HTTP endpoint for user creation, and no HTTP endpoint
 * for granting Platform Owner authority. The very first user — who alone
 * may create the first workspace — can only be created/promoted here,
 * directly in the database, via seedPlatformOwner's serialized,
 * decision-table-driven bootstrap. See platform-owner.seed.ts for the full
 * fail-loudly-on-ambiguity logic this delegates to.
 */
async function seedBootstrapOwner(prisma: PrismaClient): Promise<void> {
  const email = process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@myevmedia.com";
  const outcome = await seedPlatformOwner(prisma, {
    email,
    password: process.env.BOOTSTRAP_OWNER_PASSWORD,
    fullName: process.env.BOOTSTRAP_OWNER_NAME ?? "Platform Owner",
  });

  switch (outcome.kind) {
    case "already_correct":
      console.log(`Platform Owner already correctly set (${email}) — no-op.`);
      break;
    case "promoted":
      console.log(`Existing user promoted to Platform Owner: ${email}`);
      break;
    case "created":
      console.log(`Platform Owner created: ${email}`);
      break;
    case "skipped_no_password":
      console.log("BOOTSTRAP_OWNER_PASSWORD not set — skipping Platform Owner bootstrap.");
      break;
  }
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
