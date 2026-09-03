import { assertNoSelfLink, assertSourceEligible, assertTargetEligible, assertValidRelevanceScore, assertValidTransition } from "./internal-link-domain";

describe("assertNoSelfLink", () => {
  it("rejects identical source/target ids", () => {
    expect(() => assertNoSelfLink("a", "a")).toThrow(/self/i);
  });
  it("allows distinct ids", () => {
    expect(() => assertNoSelfLink("a", "b")).not.toThrow();
  });
});

describe("assertSourceEligible", () => {
  it.each(["DRAFT", "IN_PROGRESS"] as const)("passes for %s (not deleted)", (status) => {
    expect(() => assertSourceEligible(status, null)).not.toThrow();
  });

  it.each(["REVIEW", "APPROVED", "ARCHIVED", "DELETED", "RENDERING", "FAILED", "SCHEDULED", "PUBLISHED"] as const)("rejects %s", (status) => {
    expect(() => assertSourceEligible(status, null)).toThrow();
  });

  it("rejects an otherwise-eligible status once deletedAt is set", () => {
    expect(() => assertSourceEligible("DRAFT", new Date())).toThrow();
    expect(() => assertSourceEligible("IN_PROGRESS", new Date())).toThrow();
  });
});

describe("assertTargetEligible", () => {
  it("passes for APPROVED (not deleted)", () => {
    expect(() => assertTargetEligible("APPROVED", null)).not.toThrow();
  });

  it.each(["DRAFT", "IN_PROGRESS", "REVIEW", "ARCHIVED", "DELETED", "RENDERING", "FAILED", "SCHEDULED", "PUBLISHED"] as const)("rejects %s", (status) => {
    expect(() => assertTargetEligible(status, null)).toThrow();
  });

  it("rejects APPROVED once deletedAt is set", () => {
    expect(() => assertTargetEligible("APPROVED", new Date())).toThrow();
  });
});

describe("assertValidRelevanceScore", () => {
  it.each([0, 1, 50, 99, 100])("passes for %i", (score) => {
    expect(() => assertValidRelevanceScore(score)).not.toThrow();
  });

  it.each([-1, 101, 1.5, NaN])("rejects %s", (score) => {
    expect(() => assertValidRelevanceScore(score)).toThrow();
  });
});

describe("assertValidTransition", () => {
  const valid: Array<["GENERATED" | "ACCEPTED" | "REJECTED" | "STALE", "GENERATED" | "ACCEPTED" | "REJECTED" | "STALE"]> = [
    ["GENERATED", "ACCEPTED"],
    ["GENERATED", "REJECTED"],
    ["GENERATED", "STALE"],
    ["ACCEPTED", "STALE"],
  ];
  it.each(valid)("allows %s -> %s", (from, to) => {
    expect(() => assertValidTransition(from, to)).not.toThrow();
  });

  const invalid: Array<["GENERATED" | "ACCEPTED" | "REJECTED" | "STALE", "GENERATED" | "ACCEPTED" | "REJECTED" | "STALE"]> = [
    ["ACCEPTED", "REJECTED"], // no ACCEPTED -> REJECTED
    ["ACCEPTED", "GENERATED"],
    ["REJECTED", "GENERATED"], // no resurrection
    ["REJECTED", "ACCEPTED"],
    ["REJECTED", "STALE"],
    ["STALE", "GENERATED"], // no resurrection
    ["STALE", "ACCEPTED"],
    ["STALE", "REJECTED"],
    ["GENERATED", "GENERATED"],
  ];
  it.each(invalid)("rejects %s -> %s", (from, to) => {
    expect(() => assertValidTransition(from, to)).toThrow(/transition/i);
  });
});
