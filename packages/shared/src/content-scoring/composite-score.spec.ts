import { computeOverallContentScore } from "./composite-score";
import { ScoreOutOfRangeError } from "./score-bounds";

describe("computeOverallContentScore (frozen composite formula)", () => {
  it("is the equal-weight mean of the five universal category scores", () => {
    expect(computeOverallContentScore({ SEO: 80, VIRAL: 60, QUALITY: 90, ENGAGEMENT: 70, BUSINESS: 50 })).toBe(70);
    expect(computeOverallContentScore({ SEO: 100, VIRAL: 100, QUALITY: 100, ENGAGEMENT: 100, BUSINESS: 100 })).toBe(100);
    expect(computeOverallContentScore({ SEO: 0, VIRAL: 0, QUALITY: 0, ENGAGEMENT: 0, BUSINESS: 0 })).toBe(0);
  });

  it("rounds the mean to an integer", () => {
    // (33+33+33+33+34)/5 = 33.2 -> 33
    expect(computeOverallContentScore({ SEO: 33, VIRAL: 33, QUALITY: 33, ENGAGEMENT: 33, BUSINESS: 34 })).toBe(33);
    // (1+2+2+2+2)/5 = 1.8 -> 2
    expect(computeOverallContentScore({ SEO: 1, VIRAL: 2, QUALITY: 2, ENGAGEMENT: 2, BUSINESS: 2 })).toBe(2);
  });

  it("never depends on content-type dimension scores (only the five categories are arguments)", () => {
    // There is no parameter for a Blog/Video/Thumbnail score — this is a
    // compile-time guarantee reinforced here: identical categories =>
    // identical overall regardless of any dimension.
    const a = computeOverallContentScore({ SEO: 55, VIRAL: 55, QUALITY: 55, ENGAGEMENT: 55, BUSINESS: 55 });
    const b = computeOverallContentScore({ SEO: 55, VIRAL: 55, QUALITY: 55, ENGAGEMENT: 55, BUSINESS: 55 });
    expect(a).toBe(b);
    expect(a).toBe(55);
  });

  it("rejects an out-of-range category score", () => {
    expect(() => computeOverallContentScore({ SEO: 101, VIRAL: 50, QUALITY: 50, ENGAGEMENT: 50, BUSINESS: 50 })).toThrow(ScoreOutOfRangeError);
  });
});
