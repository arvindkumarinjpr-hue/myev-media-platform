import type { ConfigService } from "@nestjs/config";
import { BadRequestException } from "@nestjs/common";
import { ContentBodyValidator } from "./content-body-validator";
import type { AppConfig } from "../../config/configuration";

function makeValidator(overrides: Partial<AppConfig["content"]> = {}): ContentBodyValidator {
  const content: AppConfig["content"] = {
    maxBodySizeBytes: 2_000_000,
    maxBodyDepth: 10,
    maxStringValueLength: 200_000,
    base64HeuristicMinLength: 512,
    reviewCommentMaxLength: 2000,
    ...overrides,
  };
  const config = { get: () => content } as unknown as ConfigService<AppConfig, true>;
  return new ContentBodyValidator(config);
}

describe("ContentBodyValidator", () => {
  it("accepts a minimal valid BLOG body", () => {
    const validator = makeValidator();
    expect(() => validator.validate("BLOG", { content: "Hello world" })).not.toThrow();
  });

  it("accepts a minimal valid VIDEO body", () => {
    const validator = makeValidator();
    expect(() => validator.validate("VIDEO", { script: "INT. OFFICE - DAY" })).not.toThrow();
  });

  it("accepts a minimal valid SOCIAL_POST body (Module 10 Phase 10.2)", () => {
    const validator = makeValidator();
    expect(() => validator.validate("SOCIAL_POST", { caption: "Charging at home is easier than you think.", hashtags: ["#ev"] })).not.toThrow();
  });

  it("rejects a SOCIAL_POST body missing caption — a script/content field does not satisfy it", () => {
    const validator = makeValidator();
    expect(() => validator.validate("SOCIAL_POST", { script: "wrong field for social" })).toThrow(BadRequestException);
    expect(() => validator.validate("SOCIAL_POST", { content: "wrong field for social" })).toThrow(BadRequestException);
  });

  it("rejects a non-object top-level body", () => {
    const validator = makeValidator();
    expect(() => validator.validate("BLOG", "just a string")).toThrow(BadRequestException);
    expect(() => validator.validate("BLOG", ["array"])).toThrow(BadRequestException);
    expect(() => validator.validate("BLOG", null)).toThrow(BadRequestException);
  });

  it("rejects a body missing the required per-type field", () => {
    const validator = makeValidator();
    expect(() => validator.validate("BLOG", { title: "no content field" })).toThrow(BadRequestException);
    expect(() => validator.validate("VIDEO", { content: "wrong field for video" })).toThrow(BadRequestException);
  });

  it("rejects a required field that is present but empty/whitespace-only", () => {
    const validator = makeValidator();
    expect(() => validator.validate("BLOG", { content: "   " })).toThrow(BadRequestException);
  });

  it("rejects a body exceeding the configured size ceiling", () => {
    const validator = makeValidator({ maxBodySizeBytes: 100 });
    expect(() => validator.validate("BLOG", { content: "x".repeat(200) })).toThrow(BadRequestException);
  });

  it("rejects a body nested deeper than the configured max depth", () => {
    const validator = makeValidator({ maxBodyDepth: 2, maxStringValueLength: 500 });
    // depth: body(1) -> content(1, string, fine) -> nested object(2) -> deeper(3, exceeds max of 2)
    const deep = { content: "top level text", nested: { deeper: { evenDeeper: "x" } } };
    expect(() => validator.validate("BLOG", deep)).toThrow(BadRequestException);
  });

  it("accepts a body within the configured max depth", () => {
    const validator = makeValidator({ maxBodyDepth: 3 });
    const shallow = { content: "text", nested: { ok: "fine" } };
    expect(() => validator.validate("BLOG", shallow)).not.toThrow();
  });

  it("rejects a single string field exceeding the configured max length", () => {
    const validator = makeValidator({ maxStringValueLength: 50 });
    expect(() => validator.validate("BLOG", { content: "x".repeat(51) })).toThrow(BadRequestException);
  });

  it("rejects an embedded base64 data URI regardless of length", () => {
    const validator = makeValidator();
    const dataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    expect(() => validator.validate("BLOG", { content: "Some text", thumbnail: dataUri })).toThrow(BadRequestException);
  });

  it("rejects a long base64-alphabet-only string above the heuristic threshold", () => {
    const validator = makeValidator({ base64HeuristicMinLength: 20 });
    // 24 chars, base64 alphabet only, multiple of 4 — matches the Tier 3 heuristic.
    const suspicious = "QUJDREVGR0hJSktMTU5PUA==";
    expect(() => validator.validate("BLOG", { content: "text", suspicious })).toThrow(BadRequestException);
  });

  it("does not false-positive on a short id-like string below the heuristic threshold", () => {
    const validator = makeValidator({ base64HeuristicMinLength: 512 });
    // Base64-alphabet-only and a multiple of 4, but far below the min length — must pass.
    expect(() => validator.validate("BLOG", { content: "real article text", slug: "abcd1234" })).not.toThrow();
  });

  it("does not false-positive on ordinary prose containing long non-base64 text", () => {
    const validator = makeValidator({ base64HeuristicMinLength: 20 });
    const prose = "This is a perfectly ordinary sentence with spaces and punctuation, well over twenty characters long.";
    expect(() => validator.validate("BLOG", { content: prose })).not.toThrow();
  });

  it("rejects a base64-alphabet string whose length is not a multiple of 4", () => {
    const validator = makeValidator({ base64HeuristicMinLength: 10 });
    // 13 base64-alphabet chars — not a multiple of 4, so Tier 3 must not fire.
    expect(() => validator.validate("BLOG", { content: "legit text here", token: "ABCDEFGHIJKLM" })).not.toThrow();
  });

  it("walks nested arrays and objects when checking string length and binary content", () => {
    const validator = makeValidator({ maxStringValueLength: 10 });
    const nested = { content: "short", sections: [{ heading: "ok" }, { heading: "this heading is far too long" }] };
    expect(() => validator.validate("BLOG", nested)).toThrow(BadRequestException);
  });
});
