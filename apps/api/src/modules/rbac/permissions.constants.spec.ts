import { PERMISSION_CATEGORIES, PERMISSIONS, ROLE_PERMISSIONS } from "./permissions.constants";

/**
 * Module 9 Phase 9.1 — RBAC coverage for the new PUBLISH_CHANNEL_MANAGE
 * permission. rbac.seed.ts derives every Permission/Role/RolePermission
 * row purely from these constants (its own doc comment: "Idempotent...
 * every write is an upsert keyed on the unique name/constant"), so
 * asserting against the constants directly is a true, DB-free proxy for
 * "seeded correctly" — no test database needed.
 */
describe("PUBLISH_CHANNEL_MANAGE", () => {
  it("is categorized under Publishing alongside PUBLISH_CREATE/EXECUTE/CANCEL", () => {
    expect(PERMISSION_CATEGORIES.Publishing).toContain(PERMISSIONS.PUBLISH_CHANNEL_MANAGE);
    expect(PERMISSION_CATEGORIES.Publishing).toContain(PERMISSIONS.PUBLISH_CREATE);
    expect(PERMISSION_CATEGORIES.Publishing).toContain(PERMISSIONS.PUBLISH_EXECUTE);
    expect(PERMISSION_CATEGORIES.Publishing).toContain(PERMISSIONS.PUBLISH_CANCEL);
  });

  it("Owner holds it (Owner holds every permission)", () => {
    expect(ROLE_PERMISSIONS.Owner).toContain(PERMISSIONS.PUBLISH_CHANNEL_MANAGE);
  });

  it("Administrator holds it", () => {
    expect(ROLE_PERMISSIONS.Administrator).toContain(PERMISSIONS.PUBLISH_CHANNEL_MANAGE);
  });

  it("Publisher does NOT hold it, even though Publisher holds the other three Publishing permissions", () => {
    expect(ROLE_PERMISSIONS.Publisher).not.toContain(PERMISSIONS.PUBLISH_CHANNEL_MANAGE);
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.PUBLISH_CREATE);
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.PUBLISH_EXECUTE);
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.PUBLISH_CANCEL);
  });

  it("no other role gains it implicitly", () => {
    const rolesWithIt = Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => perms.includes(PERMISSIONS.PUBLISH_CHANNEL_MANAGE))
      .map(([role]) => role);
    expect(rolesWithIt.sort()).toEqual(["Administrator", "Owner"].sort());
  });
});
