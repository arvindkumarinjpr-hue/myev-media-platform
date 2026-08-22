import { safeNextPath } from "./safe-redirect";

describe("safeNextPath", () => {
  it("accepts a same-origin relative path", () => {
    expect(safeNextPath("/workspaces/abc/knowledge-packs")).toBe("/workspaces/abc/knowledge-packs");
  });

  it("falls back to /workspaces for null/empty", () => {
    expect(safeNextPath(null)).toBe("/workspaces");
    expect(safeNextPath("")).toBe("/workspaces");
  });

  it("rejects an absolute external URL — open-redirect protection", () => {
    expect(safeNextPath("https://evil.example")).toBe("/workspaces");
    expect(safeNextPath("http://evil.example/phish")).toBe("/workspaces");
  });

  it("rejects a protocol-relative URL", () => {
    expect(safeNextPath("//evil.example")).toBe("/workspaces");
  });

  it("rejects a path not starting with /", () => {
    expect(safeNextPath("evil.example")).toBe("/workspaces");
  });

  it("honors a custom fallback", () => {
    expect(safeNextPath(null, "/login")).toBe("/login");
  });
});
