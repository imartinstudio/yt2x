import { describe, expect, it } from "vitest";
import {
  formatMsToSrtTimestamp,
  mergeCuesIntoSegments,
  parseSrtTimestampToMs,
} from "./segment.js";
import type { DubCue } from "./types.js";

const cue = (index: number, startMs: number, endMs: number, text: string): DubCue => ({
  index,
  startMs,
  endMs,
  text,
});

describe("parseSrtTimestampToMs", () => {
  it("parses HH:MM:SS,mmm", () => {
    expect(parseSrtTimestampToMs("00:01:02,500")).toBe(62_500);
    expect(parseSrtTimestampToMs("01:00:00,000")).toBe(3_600_000);
  });

  it("parses MM:SS,mmm without the hour field", () => {
    expect(parseSrtTimestampToMs("01:02,500")).toBe(62_500);
  });

  it("accepts a dot as the decimal separator", () => {
    expect(parseSrtTimestampToMs("00:00:01.250")).toBe(1_250);
  });

  it("right-pads the millisecond field instead of reading it as a plain number", () => {
    // ",5" is half a second, not 5 milliseconds
    expect(parseSrtTimestampToMs("00:00:01,5")).toBe(1_500);
    expect(parseSrtTimestampToMs("00:00:01,05")).toBe(1_050);
    expect(parseSrtTimestampToMs("00:00:01,005")).toBe(1_005);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseSrtTimestampToMs("  00:00:02,000 ")).toBe(2_000);
  });

  it("returns NaN for malformed input", () => {
    expect(parseSrtTimestampToMs("")).toBeNaN();
    expect(parseSrtTimestampToMs("not a timestamp")).toBeNaN();
    expect(parseSrtTimestampToMs("00:00:01")).toBeNaN();
    expect(parseSrtTimestampToMs("00:00:1,000")).toBeNaN();
    expect(parseSrtTimestampToMs("00:00:01,1234")).toBeNaN();
  });
});

describe("formatMsToSrtTimestamp", () => {
  it("formats with zero padding", () => {
    expect(formatMsToSrtTimestamp(0)).toBe("00:00:00,000");
    expect(formatMsToSrtTimestamp(62_500)).toBe("00:01:02,500");
    expect(formatMsToSrtTimestamp(3_661_001)).toBe("01:01:01,001");
  });

  it("round-trips with parseSrtTimestampToMs", () => {
    for (const ms of [0, 999, 1_500, 62_500, 3_661_001, 7_322_123]) {
      expect(parseSrtTimestampToMs(formatMsToSrtTimestamp(ms))).toBe(ms);
    }
  });

  it("clamps negative input to zero", () => {
    expect(formatMsToSrtTimestamp(-1)).toBe("00:00:00,000");
    expect(formatMsToSrtTimestamp(-9_999)).toBe("00:00:00,000");
  });

  it("rounds fractional milliseconds", () => {
    expect(formatMsToSrtTimestamp(1_500.6)).toBe("00:00:01,501");
  });
});

describe("mergeCuesIntoSegments", () => {
  it("returns an empty array when there is nothing usable", () => {
    expect(mergeCuesIntoSegments([])).toEqual([]);
    expect(
      mergeCuesIntoSegments([cue(1, 0, 1_000, "   "), cue(2, 1_000, 2_000, "")]),
    ).toEqual([]);
  });

  it("skips blank cues but keeps merging the surrounding text", () => {
    const segments = mergeCuesIntoSegments(
      [cue(1, 0, 1_000, "第一句"), cue(2, 1_000, 2_000, "   "), cue(3, 2_000, 3_000, "继续说")],
      { maxGapMs: 1_500 },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("第一句继续说");
    expect(segments[0]?.cueIndices).toEqual([1, 3]);
  });

  it("breaks on sentence-final punctuation", () => {
    const segments = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "今天讲配音。"),
      cue(2, 1_000, 2_000, "先看流程"),
    ]);
    expect(segments.map((s) => s.text)).toEqual(["今天讲配音。", "先看流程"]);
    expect(segments[0]).toMatchObject({ index: 1, startMs: 0, endMs: 1_000, cueIndices: [1] });
    expect(segments[1]).toMatchObject({ index: 2, startMs: 1_000, endMs: 2_000, cueIndices: [2] });
  });

  it("breaks after a closing quote, curly or straight", () => {
    // 中文 LLM 译文里弯引号是常态，只认直引号会让整句漏判、继续往后合并
    const segments = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "他说“好。”"),
      cue(2, 1_000, 2_000, "他说\"行。\""),
      cue(3, 2_000, 3_000, "然后就开始了"),
    ]);
    expect(segments.map((s) => s.text)).toEqual(["他说“好。”", "他说\"行。\"", "然后就开始了"]);
  });

  it("breaks on sentence-final punctuation wrapped in a closing quote or bracket", () => {
    const segments = mergeCuesIntoSegments([
      cue(1, 0, 1_000, '他说"好。"'),
      cue(2, 1_000, 2_000, "然后就走了"),
    ]);
    expect(segments.map((s) => s.text)).toEqual(['他说"好。"', "然后就走了"]);

    const bracketed = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "结论是这样（真的？）"),
      cue(2, 1_000, 2_000, "接着讲"),
    ]);
    expect(bracketed.map((s) => s.text)).toEqual(["结论是这样（真的？）", "接着讲"]);
  });

  it("breaks on gaps when the source has no punctuation at all", () => {
    // YouTube 自动字幕的典型形态：整片零标点，只有换气停顿可用
    const segments = mergeCuesIntoSegments(
      [
        cue(1, 0, 1_000, "我们先看一下"),
        cue(2, 1_050, 2_000, "这个工具怎么用"),
        // 1.2s 的停顿 —— 说话人换气
        cue(3, 3_200, 4_200, "然后是第二部分"),
        cue(4, 4_250, 5_200, "也就是配音"),
      ],
      { maxGapMs: 700 },
    );
    expect(segments.map((s) => s.text)).toEqual(["我们先看一下这个工具怎么用", "然后是第二部分也就是配音"]);
    expect(segments.map((s) => s.cueIndices)).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(segments[0]).toMatchObject({ startMs: 0, endMs: 2_000 });
    expect(segments[1]).toMatchObject({ startMs: 3_200, endMs: 5_200 });
  });

  it("keeps merging across a gap that is exactly at the threshold", () => {
    const segments = mergeCuesIntoSegments(
      [cue(1, 0, 1_000, "前半句"), cue(2, 1_700, 2_500, "后半句")],
      { maxGapMs: 700 },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("前半句后半句");
  });

  it("uses maxDurationMs as a fuse when nothing else breaks the line", () => {
    const segments = mergeCuesIntoSegments(
      [
        cue(1, 0, 3_000, "一段没有标点的话"),
        cue(2, 3_000, 6_000, "继续说下去"),
        cue(3, 6_000, 9_000, "还在说"),
      ],
      { maxDurationMs: 7_000, maxGapMs: 700, maxChars: 200 },
    );
    expect(segments.map((s) => s.text)).toEqual(["一段没有标点的话继续说下去", "还在说"]);
    expect(segments[0]).toMatchObject({ startMs: 0, endMs: 6_000 });
  });

  it("uses maxChars as a fuse", () => {
    const segments = mergeCuesIntoSegments(
      [
        cue(1, 0, 1_000, "十二三四五"),
        cue(2, 1_000, 2_000, "六七八九十"),
        cue(3, 2_000, 3_000, "十一十二"),
      ],
      { maxChars: 10, maxGapMs: 700, maxDurationMs: 60_000 },
    );
    expect(segments.map((s) => s.text)).toEqual(["十二三四五六七八九十", "十一十二"]);
  });

  it("inserts a space only at latin word boundaries", () => {
    const segments = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "使用 Claude"),
      cue(2, 1_000, 2_000, "Code 来做"),
    ]);
    expect(segments).toHaveLength(1);
    expect(segments[0]?.text).toBe("使用 Claude Code 来做");
  });

  it("does not insert a space at a CJK boundary", () => {
    const segments = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "我们来"),
      cue(2, 1_000, 2_000, "试一下"),
    ]);
    expect(segments[0]?.text).toBe("我们来试一下");
  });

  it("does not insert a space when only one side is latin", () => {
    const segments = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "打开 Claude"),
      cue(2, 1_000, 2_000, "的设置面板"),
    ]);
    expect(segments[0]?.text).toBe("打开 Claude的设置面板");

    const trailing = mergeCuesIntoSegments([
      cue(1, 0, 1_000, "打开设置"),
      cue(2, 1_000, 2_000, "Claude 面板"),
    ]);
    expect(trailing[0]?.text).toBe("打开设置Claude 面板");
  });

  it("numbers segments sequentially from 1", () => {
    const segments = mergeCuesIntoSegments([
      cue(7, 0, 1_000, "第一句。"),
      cue(8, 1_000, 2_000, "第二句。"),
      cue(9, 2_000, 3_000, "第三句。"),
    ]);
    expect(segments.map((s) => s.index)).toEqual([1, 2, 3]);
    expect(segments.map((s) => s.cueIndices)).toEqual([[7], [8], [9]]);
  });
});
