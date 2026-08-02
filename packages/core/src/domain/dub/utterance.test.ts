import { describe, expect, it } from "vitest";
import { filterUtterancesByTimeRange, segmentUtterances } from "./utterance.js";
import type { TimedWord, Utterance } from "./types.js";

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

describe("segmentUtterances · 最小时长合并", () => {
  it("merges an utterance shorter than the floor into its neighbour", () => {
    const words: TimedWord[] = [
      { word: "long", startMs: 0, endMs: 2_000 },
      { word: "enough.", startMs: 2_000, endMs: 4_000 },
      // 只有 300ms，单独合成时固定开销就装不下
      { word: "Right.", startMs: 4_100, endMs: 4_400 },
    ];
    const u = segmentUtterances(words, { minDurationMs: 2_000 });
    expect(u).toHaveLength(1);
    expect(u[0]?.text).toBe("long enough. Right.");
    expect(u[0]).toMatchObject({ startMs: 0, endMs: 4_400 });
  });

  it("prefers the neighbour separated by the smaller gap", () => {
    const words: TimedWord[] = [
      { word: "first.", startMs: 0, endMs: 2_500 },
      // 距前一句 900ms、距后一句 100ms —— 应并入后一句
      { word: "Ok.", startMs: 3_400, endMs: 3_700 },
      { word: "second", startMs: 3_800, endMs: 6_000 },
      { word: "sentence.", startMs: 6_000, endMs: 8_000 },
    ];
    const u = segmentUtterances(words, { minDurationMs: 2_000 });
    expect(u).toHaveLength(2);
    expect(u[0]?.text).toBe("first.");
    expect(u[1]?.text).toBe("Ok. second sentence.");
  });

  it("leaves a short utterance alone when merging would breach the duration cap", () => {
    const words: TimedWord[] = [
      { word: "a", startMs: 0, endMs: 5_000 },
      { word: "b.", startMs: 5_000, endMs: 9_500 },
      // 并入前一句会跨到 10.4s，超过 10s 上限，因此不能并
      { word: "c.", startMs: 10_100, endMs: 10_400 },
    ];
    const u = segmentUtterances(words, { minDurationMs: 2_000, maxDurationMs: 10_000 });
    expect(u).toHaveLength(2);
    expect(u[1]?.text).toBe("c.");
  });

  it("does not merge when no floor is configured", () => {
    const words: TimedWord[] = [
      { word: "one.", startMs: 0, endMs: 3_000 },
      { word: "two.", startMs: 3_100, endMs: 3_400 },
    ];
    expect(segmentUtterances(words)).toHaveLength(2);
  });

  it("keeps a lone short utterance rather than dropping it", () => {
    const u = segmentUtterances([{ word: "Hi.", startMs: 0, endMs: 400 }], {
      minDurationMs: 2_000,
    });
    expect(u).toHaveLength(1);
    expect(u[0]?.text).toBe("Hi.");
  });
});

describe("filterUtterancesByTimeRange", () => {
  const utterances: Utterance[] = [
    { index: 1, startMs: 1_000, endMs: 3_500, text: "we look at this first", wordCount: 5 },
    { index: 2, startMs: 3_500, endMs: 6_000, text: "how this tool works", wordCount: 4 },
  ];

  it("keeps all utterances unchanged when no range is set", () => {
    expect(filterUtterancesByTimeRange(utterances, {})).toEqual(utterances);
  });

  it("keeps only overlapping utterances and shifts them to the window origin", () => {
    expect(filterUtterancesByTimeRange(utterances, { startMs: 2_000, endMs: 5_000 })).toEqual([
      { index: 1, startMs: 0, endMs: 1_500, text: "we look at this first", wordCount: 5 },
      { index: 2, startMs: 1_500, endMs: 3_000, text: "how this tool works", wordCount: 4 },
    ]);
  });

  it("renumbers surviving utterances sequentially from 1", () => {
    const filtered = filterUtterancesByTimeRange(utterances, { startMs: 3_000 });
    expect(filtered.map((u) => u.index)).toEqual([1, 2]);
  });

  it("rejects an inverted range", () => {
    expect(() =>
      filterUtterancesByTimeRange(utterances, { startMs: 5_000, endMs: 1_000 }),
    ).toThrow(/endMs.*startMs/iu);
  });

  it("drops utterances entirely outside the window", () => {
    expect(filterUtterancesByTimeRange(utterances, { startMs: 10_000, endMs: 20_000 })).toEqual(
      [],
    );
  });
});
