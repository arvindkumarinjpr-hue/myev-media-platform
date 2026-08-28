import { assertInScoreRange, clampScore, isInScoreRange, roundScore, ScoreOutOfRangeError } from "./score-bounds";

describe("score-bounds", () => {
  it("accepts values within [0, 100]", () => {
    for (const v of [0, 1, 50, 99.9, 100]) expect(isInScoreRange(v)).toBe(true);
  });

  it("rejects out-of-range and non-finite values", () => {
    for (const v of [-1, 100.001, NaN, Infinity, -Infinity]) expect(isInScoreRange(v)).toBe(false);
  });

  it("assertInScoreRange throws a labelled ScoreOutOfRangeError", () => {
    expect(() => assertInScoreRange("category X", 120)).toThrow(ScoreOutOfRangeError);
    try {
      assertInScoreRange("category X", 120);
    } catch (e) {
      expect((e as ScoreOutOfRangeError).label).toBe("category X");
      expect((e as ScoreOutOfRangeError).value).toBe(120);
    }
  });

  it("clampScore pins into range and maps non-finite to 0", () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(150)).toBe(100);
    expect(clampScore(42)).toBe(42);
    expect(clampScore(NaN)).toBe(0);
  });

  it("roundScore clamps then rounds to an integer", () => {
    expect(roundScore(99.4)).toBe(99);
    expect(roundScore(99.5)).toBe(100);
    expect(roundScore(-0.4)).toBe(0);
    expect(roundScore(100.6)).toBe(100);
  });
});
