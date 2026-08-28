import { averageWordsPerSentence, bandScore, containsPhrase, phraseCoverage, phraseOccurrences, rampScore, sentenceCount, tokenizeWords, wordCount } from "./text-analysis";

describe("text-analysis helpers", () => {
  it("tokenizes and counts words across punctuation", () => {
    expect(tokenizeWords("Hello, world! It's EV-charging.")).toEqual(["hello", "world", "it", "s", "ev", "charging"]);
    expect(wordCount("one two three")).toBe(3);
    expect(wordCount("")).toBe(0);
  });

  it("counts sentences and averages", () => {
    expect(sentenceCount("One. Two! Three?")).toBe(3);
    expect(sentenceCount("no terminator here")).toBe(1);
    expect(averageWordsPerSentence("a b c. d e f.")).toBeCloseTo(3);
  });

  it("phraseOccurrences is whole-word for single tokens, substring for phrases, case-insensitive", () => {
    expect(phraseOccurrences("Charging chargers charge", "charge")).toBe(1);
    expect(phraseOccurrences("home EV charging is home ev charging", "home ev charging")).toBe(2);
    expect(containsPhrase("The Best Guide", "best")).toBe(true);
    expect(containsPhrase("bestseller", "best")).toBe(false);
  });

  it("phraseCoverage counts how many phrases appear at least once", () => {
    expect(phraseCoverage("a c e", ["a", "b", "c", "d"])).toBe(2);
    expect(phraseCoverage("nothing here", [])).toBe(0);
  });

  it("bandScore is 100 inside the ideal band and ramps to the floor outside", () => {
    expect(bandScore(50, { min: 10, idealLow: 40, idealHigh: 65, max: 110, floorScore: 20 })).toBe(100);
    expect(bandScore(10, { min: 10, idealLow: 40, idealHigh: 65, max: 110, floorScore: 20 })).toBe(20);
    expect(bandScore(110, { min: 10, idealLow: 40, idealHigh: 65, max: 110, floorScore: 20 })).toBe(20);
    const below = bandScore(25, { min: 10, idealLow: 40, idealHigh: 65, max: 110, floorScore: 20 });
    expect(below).toBeGreaterThan(20);
    expect(below).toBeLessThan(100);
    // monotone rising towards the ideal band
    expect(bandScore(30, { min: 10, idealLow: 40, idealHigh: 65, max: 110, floorScore: 20 })).toBeGreaterThan(below);
  });

  it("rampScore clamps to [0,100] and is linear between endpoints", () => {
    expect(rampScore(0, 0, 4)).toBe(0);
    expect(rampScore(4, 0, 4)).toBe(100);
    expect(rampScore(2, 0, 4)).toBe(50);
    expect(rampScore(10, 0, 4)).toBe(100);
    expect(rampScore(-3, 0, 4)).toBe(0);
  });
});
