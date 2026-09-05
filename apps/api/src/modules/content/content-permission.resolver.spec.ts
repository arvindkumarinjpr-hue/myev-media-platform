import type { PermissionResolver } from "../rbac/permission-resolver.interface";
import { PERMISSIONS, type PermissionConstant } from "../rbac/permissions.constants";
import { ContentPermissionResolver, isSupportedContentType, SUPPORTED_CONTENT_TYPES } from "./content-permission.resolver";

function fakeResolver(granted: PermissionConstant[]): PermissionResolver {
  return { resolve: jest.fn().mockResolvedValue(granted) };
}

describe("isSupportedContentType", () => {
  it("accepts BLOG, VIDEO, and SOCIAL_POST (Module 10 Phase 10.1 — the reserved type this module activates)", () => {
    expect(isSupportedContentType("BLOG")).toBe(true);
    expect(isSupportedContentType("VIDEO")).toBe(true);
    expect(isSupportedContentType("SOCIAL_POST")).toBe(true);
  });

  it("rejects the 3 still-deferred content types", () => {
    for (const type of ["SHORT", "REEL", "NEWSLETTER"] as const) {
      expect(isSupportedContentType(type)).toBe(false);
    }
  });
});

describe("ContentPermissionResolver.can", () => {
  it("grants create/view/edit/approve for BLOG when the matching BLOG_* permission is held", async () => {
    const resolver = new ContentPermissionResolver(
      fakeResolver([PERMISSIONS.BLOG_CREATE, PERMISSIONS.BLOG_VIEW, PERMISSIONS.BLOG_EDIT, PERMISSIONS.BLOG_APPROVE]),
    );
    await expect(resolver.can("user-1", "ws-1", "create", "BLOG")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "view", "BLOG")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "edit", "BLOG")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "approve", "BLOG")).resolves.toBe(true);
  });

  it("grants create/view/edit/approve for SOCIAL_POST when the matching SOCIAL_* permission is held", async () => {
    const resolver = new ContentPermissionResolver(
      fakeResolver([PERMISSIONS.SOCIAL_CREATE, PERMISSIONS.SOCIAL_VIEW, PERMISSIONS.SOCIAL_EDIT, PERMISSIONS.SOCIAL_APPROVE]),
    );
    await expect(resolver.can("user-1", "ws-1", "create", "SOCIAL_POST")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "view", "SOCIAL_POST")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "edit", "SOCIAL_POST")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "approve", "SOCIAL_POST")).resolves.toBe(true);
  });

  it("does not let a BLOG permission authorize a VIDEO or SOCIAL_POST action, or vice versa", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.BLOG_EDIT]));
    await expect(resolver.can("user-1", "ws-1", "edit", "VIDEO")).resolves.toBe(false);
    await expect(resolver.can("user-1", "ws-1", "edit", "SOCIAL_POST")).resolves.toBe(false);

    const videoResolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.VIDEO_EDIT]));
    await expect(videoResolver.can("user-1", "ws-1", "edit", "BLOG")).resolves.toBe(false);
    await expect(videoResolver.can("user-1", "ws-1", "edit", "SOCIAL_POST")).resolves.toBe(false);

    const socialResolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.SOCIAL_EDIT]));
    await expect(socialResolver.can("user-1", "ws-1", "edit", "BLOG")).resolves.toBe(false);
    await expect(socialResolver.can("user-1", "ws-1", "edit", "VIDEO")).resolves.toBe(false);
  });

  it("denies when the caller holds no relevant permission", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([]));
    await expect(resolver.can("user-1", "ws-1", "create", "BLOG")).resolves.toBe(false);
  });

  it("denies for a still-unsupported content type even if the caller holds every permission", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver(Object.values(PERMISSIONS)));
    await expect(resolver.can("user-1", "ws-1", "view", "SHORT")).resolves.toBe(false);
    await expect(resolver.can("user-1", "ws-1", "view", "REEL")).resolves.toBe(false);
    await expect(resolver.can("user-1", "ws-1", "view", "NEWSLETTER")).resolves.toBe(false);
  });

  it("approve and edit are gated by distinct permissions — editing does not imply approval authority", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.BLOG_EDIT]));
    await expect(resolver.can("user-1", "ws-1", "edit", "BLOG")).resolves.toBe(true);
    await expect(resolver.can("user-1", "ws-1", "approve", "BLOG")).resolves.toBe(false);

    const socialResolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.SOCIAL_EDIT]));
    await expect(socialResolver.can("user-1", "ws-1", "edit", "SOCIAL_POST")).resolves.toBe(true);
    await expect(socialResolver.can("user-1", "ws-1", "approve", "SOCIAL_POST")).resolves.toBe(false);
  });
});

describe("ContentPermissionResolver.getViewableContentTypes", () => {
  it("returns an empty list when no view permission is held", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.BLOG_EDIT]));
    await expect(resolver.getViewableContentTypes("user-1", "ws-1")).resolves.toEqual([]);
  });

  it("returns only BLOG when just BLOG_VIEW is held", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.BLOG_VIEW]));
    await expect(resolver.getViewableContentTypes("user-1", "ws-1")).resolves.toEqual(["BLOG"]);
  });

  it("returns only VIDEO when just VIDEO_VIEW is held", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.VIDEO_VIEW]));
    await expect(resolver.getViewableContentTypes("user-1", "ws-1")).resolves.toEqual(["VIDEO"]);
  });

  it("returns only SOCIAL_POST when just SOCIAL_VIEW is held", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.SOCIAL_VIEW]));
    await expect(resolver.getViewableContentTypes("user-1", "ws-1")).resolves.toEqual(["SOCIAL_POST"]);
  });

  it("returns all three when all three view permissions are held", async () => {
    const resolver = new ContentPermissionResolver(fakeResolver([PERMISSIONS.BLOG_VIEW, PERMISSIONS.VIDEO_VIEW, PERMISSIONS.SOCIAL_VIEW]));
    const result = await resolver.getViewableContentTypes("user-1", "ws-1");
    expect(result.sort()).toEqual([...SUPPORTED_CONTENT_TYPES].sort());
  });
});
