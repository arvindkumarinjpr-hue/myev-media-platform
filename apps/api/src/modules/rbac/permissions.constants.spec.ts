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

/**
 * Module 10 Phase 10.1 — RBAC coverage for the 4 new SOCIAL_* permissions.
 * Same DB-free proxy precedent as PUBLISH_CHANNEL_MANAGE above. Exact role
 * assignments are frozen product decisions (Architecture Checkpoint §20 /
 * Phase 10.1 Part B), not derived — this test is the executable record of
 * that frozen matrix.
 */
describe("SOCIAL_* permissions (Module 10 Phase 10.1)", () => {
  it("is categorized under Social alongside CREATE/VIEW/EDIT/APPROVE", () => {
    expect(PERMISSION_CATEGORIES.Social).toEqual([PERMISSIONS.SOCIAL_CREATE, PERMISSIONS.SOCIAL_VIEW, PERMISSIONS.SOCIAL_EDIT, PERMISSIONS.SOCIAL_APPROVE]);
  });

  function rolesHolding(permission: string): string[] {
    return Object.entries(ROLE_PERMISSIONS)
      .filter(([, perms]) => perms.includes(permission as never))
      .map(([role]) => role)
      .sort();
  }

  it("SOCIAL_CREATE: Owner, Administrator, Content Manager, Content Writer — exactly", () => {
    expect(rolesHolding(PERMISSIONS.SOCIAL_CREATE)).toEqual(["Administrator", "Content Manager", "Content Writer", "Owner"].sort());
  });

  it("SOCIAL_VIEW: Owner, Administrator, Content Manager, Content Writer, SEO Specialist, Publisher — exactly", () => {
    expect(rolesHolding(PERMISSIONS.SOCIAL_VIEW)).toEqual(["Administrator", "Content Manager", "Content Writer", "Owner", "Publisher", "SEO Specialist"].sort());
  });

  it("SOCIAL_EDIT: Owner, Administrator, Content Manager, Content Writer — exactly", () => {
    expect(rolesHolding(PERMISSIONS.SOCIAL_EDIT)).toEqual(["Administrator", "Content Manager", "Content Writer", "Owner"].sort());
  });

  it("SOCIAL_APPROVE: Owner, Administrator, Content Manager — exactly (never Content Writer)", () => {
    expect(rolesHolding(PERMISSIONS.SOCIAL_APPROVE)).toEqual(["Administrator", "Content Manager", "Owner"].sort());
  });

  it("Video Editor and Analyst hold NO social permission — the frozen matrix's explicit 'none'", () => {
    for (const social of [PERMISSIONS.SOCIAL_CREATE, PERMISSIONS.SOCIAL_VIEW, PERMISSIONS.SOCIAL_EDIT, PERMISSIONS.SOCIAL_APPROVE]) {
      expect(ROLE_PERMISSIONS["Video Editor"]).not.toContain(social);
      expect(ROLE_PERMISSIONS.Analyst).not.toContain(social);
    }
  });

  it("Publisher never gains social create/edit/approve authority — view only, per the frozen matrix's explicit boundary", () => {
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.SOCIAL_VIEW);
    expect(ROLE_PERMISSIONS.Publisher).not.toContain(PERMISSIONS.SOCIAL_CREATE);
    expect(ROLE_PERMISSIONS.Publisher).not.toContain(PERMISSIONS.SOCIAL_EDIT);
    expect(ROLE_PERMISSIONS.Publisher).not.toContain(PERMISSIONS.SOCIAL_APPROVE);
    // And Publisher's own existing Publishing permissions are untouched by this change.
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.PUBLISH_CREATE);
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.PUBLISH_EXECUTE);
    expect(ROLE_PERMISSIONS.Publisher).toContain(PERMISSIONS.PUBLISH_CANCEL);
    expect(ROLE_PERMISSIONS.Publisher).not.toContain(PERMISSIONS.PUBLISH_CHANNEL_MANAGE);
  });

  it("existing Blog/Video/Publishing role assignments are unaffected by this addition", () => {
    expect(ROLE_PERMISSIONS.Owner).toContain(PERMISSIONS.BLOG_CREATE);
    expect(ROLE_PERMISSIONS.Owner).toContain(PERMISSIONS.VIDEO_CREATE);
    expect(ROLE_PERMISSIONS["Content Writer"]).toEqual(
      expect.arrayContaining([PERMISSIONS.BLOG_CREATE, PERMISSIONS.BLOG_EDIT, PERMISSIONS.BLOG_VIEW, PERMISSIONS.RESEARCH_RUN, PERMISSIONS.KP_VIEW, PERMISSIONS.MEDIA_VIEW, PERMISSIONS.MEDIA_UPLOAD]),
    );
    expect(ROLE_PERMISSIONS["Content Writer"]).not.toContain(PERMISSIONS.VIDEO_CREATE);
    expect(ROLE_PERMISSIONS["Video Editor"]).toEqual(expect.arrayContaining([PERMISSIONS.VIDEO_CREATE, PERMISSIONS.VIDEO_RENDER, PERMISSIONS.VIDEO_EDIT, PERMISSIONS.VIDEO_VIEW]));
    expect(ROLE_PERMISSIONS["SEO Specialist"]).toEqual(expect.arrayContaining([PERMISSIONS.SEO_EDIT, PERMISSIONS.SEO_SCORE, PERMISSIONS.SEO_APPROVE, PERMISSIONS.BLOG_VIEW, PERMISSIONS.VIDEO_VIEW]));
  });

  it("every PERMISSIONS constant used anywhere in ROLE_PERMISSIONS is a real key of PERMISSIONS — no typo introduced", () => {
    const validValues = new Set(Object.values(PERMISSIONS));
    for (const perms of Object.values(ROLE_PERMISSIONS)) {
      for (const p of perms) expect(validValues.has(p)).toBe(true);
    }
  });
});
