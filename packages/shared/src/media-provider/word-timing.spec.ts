import { validateWordTimings, WordTimingValidationError } from "./word-timing";

describe("validateWordTimings", () => {
  it("accepts a well-formed monotonic stream", () => {
    expect(() =>
      validateWordTimings([
        { word: "hello", startMs: 0, endMs: 300 },
        { word: "world", startMs: 320, endMs: 700 },
      ]),
    ).not.toThrow();
  });

  it("rejects an empty stream", () => {
    expect(() => validateWordTimings([])).toThrow(WordTimingValidationError);
  });

  it("rejects a non-integer or negative startMs", () => {
    expect(() => validateWordTimings([{ word: "a", startMs: -1, endMs: 10 }])).toThrow(/invalid startMs/);
    expect(() => validateWordTimings([{ word: "a", startMs: 1.5, endMs: 10 }])).toThrow(/invalid startMs/);
  });

  it("rejects endMs <= startMs", () => {
    expect(() => validateWordTimings([{ word: "a", startMs: 100, endMs: 100 }])).toThrow(/endMs/);
  });

  it("rejects a blank word", () => {
    expect(() => validateWordTimings([{ word: "  ", startMs: 0, endMs: 10 }])).toThrow(/no word text/);
  });

  it("rejects a start-time regression", () => {
    expect(() =>
      validateWordTimings([
        { word: "a", startMs: 500, endMs: 800 },
        { word: "b", startMs: 400, endMs: 900 },
      ]),
    ).toThrow(/starts before the previous/);
  });

  it("allows small overlaps between adjacent words (real coarticulation)", () => {
    expect(() =>
      validateWordTimings([
        { word: "a", startMs: 0, endMs: 400 },
        { word: "b", startMs: 380, endMs: 700 },
      ]),
    ).not.toThrow();
  });
});
