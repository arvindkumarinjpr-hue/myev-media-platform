import { buildObjectKey, extractExtension, normalizeFilename } from "./object-key.util";

describe("normalizeFilename", () => {
  it("passes through an already-safe filename", () => {
    expect(normalizeFilename("photo.jpg")).toBe("photo.jpg");
  });

  it("strips path separators — never authoritative for the object path", () => {
    expect(normalizeFilename("../../etc/passwd")).not.toContain("/");
    expect(normalizeFilename("..\\..\\windows\\system32\\evil.exe")).not.toContain("\\");
  });

  it("replaces control characters rather than passing them through", () => {
    expect(normalizeFilename("evil\x00name\x01.png")).toBe("evil_name_.png");
  });

  it("replaces path separators with underscores rather than deleting them", () => {
    // Deleting them outright risks collapsing distinct inputs ("a/b" and
    // "ab") into the same normalized name.
    expect(normalizeFilename("///")).toBe("___");
  });

  it("falls back to a safe default only for a genuinely empty input", () => {
    expect(normalizeFilename("")).toBe("file");
  });

  it("still replaces (not silently drops) non-printable-ASCII control characters", () => {
    expect(normalizeFilename("\x00\x01\x02")).toBe("___");
  });

  it("caps length", () => {
    const long = "a".repeat(500) + ".jpg";
    expect(normalizeFilename(long).length).toBeLessThanOrEqual(180);
  });
});

describe("extractExtension", () => {
  it("extracts a simple extension, lowercased", () => {
    expect(extractExtension("Photo.JPG")).toBe(".jpg");
  });

  it("returns empty string when there is no extension", () => {
    expect(extractExtension("README")).toBe("");
  });
});

describe("buildObjectKey", () => {
  it("builds a workspace-prefixed, non-guessable key with every dynamic segment server-derived", () => {
    const key = buildObjectKey({
      workspacePublicId: "ws-123",
      projectPublicId: "proj-456",
      assetType: "IMAGE",
      assetId: "asset-789",
      versionNumber: 1,
      normalizedFilename: "photo.jpg",
    });
    expect(key).toBe("workspaces/ws-123/projects/proj-456/image/asset-789/1/photo.jpg");
  });

  it("uses 'unassigned' for a workspace-level asset with no project", () => {
    const key = buildObjectKey({
      workspacePublicId: "ws-123",
      projectPublicId: null,
      assetType: "DOCUMENT",
      assetId: "asset-789",
      versionNumber: 1,
      normalizedFilename: "brief.pdf",
    });
    expect(key).toContain("/projects/unassigned/");
  });

  it("gives each version its own key — never reused/overwritten", () => {
    const base = { workspacePublicId: "ws-1", projectPublicId: null, assetType: "IMAGE" as const, assetId: "asset-1", normalizedFilename: "a.png" };
    const v1 = buildObjectKey({ ...base, versionNumber: 1 });
    const v2 = buildObjectKey({ ...base, versionNumber: 2 });
    expect(v1).not.toBe(v2);
  });
});
