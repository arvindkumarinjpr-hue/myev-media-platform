import { sanitizeFilename, sanitizeId } from "./render-temp";

describe("render-temp path hardening (checkpoint §28)", () => {
  it("sanitizeId strips everything but [A-Za-z0-9-] and bounds length", () => {
    expect(sanitizeId("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeId("abc-123-DEF")).toBe("abc-123-DEF");
    expect(sanitizeId("")).toBe("unknown");
    expect(sanitizeId("x".repeat(200)).length).toBe(64);
  });

  it("sanitizeFilename removes traversal + separators and leading dots", () => {
    expect(sanitizeFilename("../../../secret.mp4")).not.toMatch(/\.\.|\//);
    expect(sanitizeFilename("scene-1.png")).toBe("scene-1.png");
    expect(sanitizeFilename("/abs/path")).toBe("_abs_path");
    expect(sanitizeFilename("...hidden")).toMatch(/^_/);
    expect(sanitizeFilename("")).toBe("asset");
    expect(sanitizeFilename("a b*c?.png")).toBe("a_b_c_.png");
  });
});
