import { describe, expect, it } from "vitest";
import { segmentUtterances } from "./utterance.js";
import type { TimedWord } from "./types.js";

/** 连续词流：每词 200ms，词间无间隔，模拟 ASR 的典型输出。 */
const stream = (text: string, startMs = 0, gapMs = 0): TimedWord[] => {
  let cursor = startMs;
  return text.split(" ").map((word) => {
    const w = { word, startMs: cursor, endMs: cursor + 200 };
    cursor += 200 + gapMs;
    return w;
  });
};

describe("segmentUtterances", () => {
  it("returns nothing for an empty word stream", () => {
    expect(segmentUtterances([])).toEqual([]);
  });

  it("splits after sentence-final punctuation", () => {
    const u = segmentUtterances(stream("hello there. how are you? fine!"));
    expect(u.map((x) => x.text)).toEqual(["hello there.", "how are you?", "fine!"]);
  });

  it("does not split on a comma or other mid-sentence punctuation", () => {
    const u = segmentUtterances(stream("first, second; third: fourth."));
    expect(u).toHaveLength(1);
    expect(u[0]?.text).toBe("first, second; third: fourth.");
  });

  it("splits after punctuation followed by a closing quote or bracket", () => {
    const u = segmentUtterances(stream('he said "go." then left.'));
    expect(u.map((x) => x.text)).toEqual(['he said "go."', "then left."]);
  });

  it("takes start and end from the first and last word of the utterance", () => {
    const u = segmentUtterances(stream("one two. three four."));
    expect(u[0]).toMatchObject({ index: 1, startMs: 0, endMs: 400, wordCount: 2 });
    expect(u[1]).toMatchObject({ index: 2, startMs: 400, endMs: 800, wordCount: 2 });
  });

  it("covers every word exactly once, in order, without overlap", () => {
    const words = stream("a b. c d e. f g h i.");
    const u = segmentUtterances(words);
    expect(u.reduce((n, x) => n + x.wordCount, 0)).toBe(words.length);
    for (let i = 1; i < u.length; i++) {
      expect(u[i]!.startMs).toBeGreaterThanOrEqual(u[i - 1]!.endMs);
    }
  });

  // 兜底：ASR 偶尔整段不给句末标点，不能让一整片并成一个合成单位
  it("breaks an over-long run at its widest internal pause", () => {
    const words: TimedWord[] = [
      { word: "aaa", startMs: 0, endMs: 1_000 },
      { word: "bbb", startMs: 1_000, endMs: 2_000 },
      // 明显更宽的换气点
      { word: "ccc", startMs: 2_600, endMs: 3_600 },
      { word: "ddd", startMs: 3_600, endMs: 4_600 },
    ];
    const u = segmentUtterances(words, { maxDurationMs: 3_000 });
    expect(u).toHaveLength(2);
    expect(u[0]?.text).toBe("aaa bbb");
    expect(u[1]?.text).toBe("ccc ddd");
  });

  it("falls back to breaking at the word-count fuse when pauses are uniform", () => {
    const u = segmentUtterances(stream("a b c d e f"), { maxWords: 2 });
    expect(u.map((x) => x.wordCount)).toEqual([2, 2, 2]);
  });

  it("keeps a trailing run that never reaches punctuation", () => {
    const u = segmentUtterances(stream("done. and then more"));
    expect(u.map((x) => x.text)).toEqual(["done.", "and then more"]);
  });

  it("ignores blank words without breaking the timeline", () => {
    const words: TimedWord[] = [
      { word: "one", startMs: 0, endMs: 200 },
      { word: "   ", startMs: 200, endMs: 260 },
      { word: "two.", startMs: 260, endMs: 460 },
    ];
    const u = segmentUtterances(words);
    expect(u).toHaveLength(1);
    expect(u[0]).toMatchObject({ text: "one two.", startMs: 0, endMs: 460, wordCount: 2 });
  });
});
