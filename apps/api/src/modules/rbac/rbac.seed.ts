import type { PrismaClient } from "../../../generated/prisma";
import { PERMISSIONS, PERMISSION_CATEGORIES, ROLE_PERMISSIONS } from "./permissions.constants";

/**
 * Idempotent: every write is an upsert keyed on the unique `name`/
 * `constant`, safe to re-run (Module 1B.1 Engineering Plan §8, §18
 * decision confirming seed idempotency as a requirement).
 */
export async function seedRbac(prisma: PrismaClient): Promise<void> {
  const categoryByPermission = new Map<string, string>();
  for (const [category, perms] of Object.entries(PERMISSION_CATEGORIES)) {
    for (const perm of perms) categoryByPermission.set(perm, category);
  }

  for (const constant of Object.values(PERMISSIONS)) {
    await prisma.permission.upsert({
      where: { constant },
      update: { category: categoryByPermission.get(constant) ?? "Uncategorized" },
      create: { constant, category: categoryByPermission.get(constant) ?? "Uncategorized" },
    });
  }

  for (const [roleName, permissionConstants] of Object.entries(ROLE_PERMISSIONS)) {
    const role = await prisma.role.upsert({
      where: { name: roleName },
      update: {},
      create: { name: roleName },
    });

    const permissions = await prisma.permission.findMany({
      where: { constant: { in: permissionConstants } },
    });

    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: {},
        create: { roleId: role.id, permissionId: permission.id },
      });
    }
  }
}
