import { buildSubtitles, SubtitleAlignmentError } from "./subtitle-builder";
import type { WordTiming } from "./word-timing";

function timings(words: string[], msPerWord = 400, gap = 60): WordTiming[] {
  const out: WordTiming[] = [];
  let cursor = 0;
  for (const w of words) {
    out.push({ word: w, startMs: cursor, endMs: cursor + msPerWord - gap });
    cursor += msPerWord;
  }
  return out;
}

const SCRIPT = "Electric vehicles are changing how India moves. Here is what you need to know before buying one today.";
const WORDS = SCRIPT.split(" ");

describe("buildSubtitles", () => {
  it("is deterministic — same inputs produce identical bytes", () => {
    const t = timings(WORDS);
    const a = buildSubtitles(SCRIPT, t, { audioDurationMs: WORDS.length * 400 + 500 });
    const b = buildSubtitles(SCRIPT, t, { audioDurationMs: WORDS.length * 400 + 500 });
    expect(a.srt).toEqual(b.srt);
    expect(a.vtt).toEqual(b.vtt);
    expect(a.cueCount).toBe(b.cueCount);
  });

  it("produces a valid VTT header and SRT numbering", () => {
    const res = buildSubtitles(SCRIPT, timings(WORDS), { audioDurationMs: WORDS.length * 400 + 500 });
    expect(res.vtt.startsWith("WEBVTT\n")).toBe(true);
    expect(res.srt).toMatch(/^1\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/);
    expect(res.cues.length).toBeGreaterThan(0);
  });

  it("keeps every cue monotonic, non-overlapping and within the audio", () => {
    const audio = WORDS.length * 400 + 500;
    const res = buildSubtitles(SCRIPT, timings(WORDS), { audioDurationMs: audio });
    let prevEnd = -1;
    for (const cue of res.cues) {
      expect(cue.startMs).toBeGreaterThan(prevEnd);
      expect(cue.endMs).toBeGreaterThan(cue.startMs);
      expect(cue.endMs).toBeLessThanOrEqual(audio);
      prevEnd = cue.endMs;
    }
  });

  it("segments long text into multiple cues", () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const res = buildSubtitles(long, timings(long.split(" ")), { audioDurationMs: 60 * 400 + 1000 });
    expect(res.cueCount).toBeGreaterThan(1);
  });

  it("fails safely on a word-count mismatch beyond tolerance", () => {
    expect(() => buildSubtitles(SCRIPT, timings(WORDS.slice(0, 3)), { audioDurationMs: 5000 })).toThrow(SubtitleAlignmentError);
  });

  it("fails safely on a malformed timing stream", () => {
    expect(() => buildSubtitles(SCRIPT, [{ word: "x", startMs: 0, endMs: 0 }], { audioDurationMs: 1000 })).toThrow();
  });

  it("clamps the final cue to the audio end rather than overrunning", () => {
    const res = buildSubtitles(SCRIPT, timings(WORDS, 400), { audioDurationMs: 3000 });
    expect(res.cues[res.cues.length - 1].endMs).toBeLessThanOrEqual(3000);
  });
});
