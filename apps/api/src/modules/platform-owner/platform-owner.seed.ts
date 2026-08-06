import * as argon2 from "argon2";
import type { PrismaClient } from "../../../generated/prisma";
import { ARGON2_OPTIONS } from "../../common/crypto/password-hash.service";

/**
 * Arbitrary, fixed advisory-lock key for serializing Platform Owner
 * bootstrap evaluation (Module 1C Engineering Plan, mandatory safeguard 3).
 * Any distinct bigint works — this one has no meaning beyond being unique
 * to this operation, so two concurrent bootstrap attempts (e.g. a scaled
 * deployment running the seed job twice) contend for the same Postgres
 * advisory lock rather than racing each other's reads and writes.
 */
const PLATFORM_OWNER_BOOTSTRAP_LOCK_KEY = 847_001_223n;

export interface PlatformOwnerBootstrapConfig {
  email: string;
  password?: string;
  fullName: string;
}

export type PlatformOwnerBootstrapOutcome =
  | { kind: "already_correct" }
  | { kind: "promoted"; userId: string }
  | { kind: "created"; userId: string }
  | { kind: "skipped_no_password" };

/**
 * Module 1C Engineering Plan §2. The only code path anywhere in this
 * application that may ever set `is_platform_owner = true`. Runs the
 * decision table inside one transaction, serialized by a transaction-scoped
 * Postgres advisory lock (released automatically at commit/rollback — no
 * separate unlock step). The partial unique index on
 * users(is_platform_owner) WHERE is_platform_owner AND deleted_at IS NULL
 * remains the final, DB-enforced invariant — this function is what keeps
 * the *decision* of who gets promoted safe under concurrency; the index is
 * what makes an incorrect decision impossible to persist even if this
 * logic were ever bypassed.
 */
export async function seedPlatformOwner(
  prisma: PrismaClient,
  config: PlatformOwnerBootstrapConfig,
): Promise<PlatformOwnerBootstrapOutcome> {
  const email = config.email.toLowerCase();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLATFORM_OWNER_BOOTSTRAP_LOCK_KEY})`;

    const activeOwners = await tx.user.findMany({
      where: { isPlatformOwner: true, deletedAt: null },
    });

    if (activeOwners.length > 1) {
      throw new Error("FATAL: more than one active Platform Owner exists. Manual remediation required.");
    }

    if (activeOwners.length === 1) {
      if (activeOwners[0].email !== email) {
        throw new Error(
          `FATAL: an active Platform Owner already exists (${activeOwners[0].email}), but the configured bootstrap ` +
            `identity is ${email}. Refusing to silently transfer Platform Owner authority.`,
        );
      }
      return { kind: "already_correct" };
    }

    // activeOwners.length === 0 from here. Distinguish "nobody has ever
    // held this" from "someone held it and was later soft-deleted" — the
    // latter is deliberately NOT treated as equivalent to a fresh install,
    // even if the soft-deleted owner's email happens to match config (see
    // MODULE_1C_ENGINEERING PLAN §2: "never silently transfer" extended to
    // "never silently replace").
    const anyOwnerEver = await tx.user.findMany({ where: { isPlatformOwner: true } });
    if (anyOwnerEver.length > 0) {
      throw new Error(
        "FATAL: a previously-designated Platform Owner exists but is soft-deleted. Refusing to auto-create a " +
          "replacement. Manual remediation required (restore the account, or explicitly clear is_platform_owner, " +
          "before re-seeding).",
      );
    }

    if (!config.password) {
      return { kind: "skipped_no_password" };
    }

    const existingUser = await tx.user.findFirst({ where: { email, deletedAt: null } });
    if (existingUser) {
      await tx.user.update({ where: { id: existingUser.id }, data: { isPlatformOwner: true } });
      return { kind: "promoted", userId: existingUser.id };
    }

    const passwordHash = await argon2.hash(config.password, ARGON2_OPTIONS);
    const user = await tx.user.create({
      data: {
        email,
        fullName: config.fullName,
        status: "ACTIVE",
        passwordHash,
        activatedAt: new Date(),
        isPlatformOwner: true,
      },
    });
    await tx.userPasswordHistory.create({ data: { userId: user.id, passwordHash } });
    return { kind: "created", userId: user.id };
  });
}
