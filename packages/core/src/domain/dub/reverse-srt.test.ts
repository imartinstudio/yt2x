import { describe, expect, it } from "vitest";
import { buildReverseSrtCues, formatReverseSrt } from "./reverse-srt.js";
import type { DubPlacedLine, DubScriptLine } from "./types.js";

const placed = (
  index: number,
  startMs: number,
  endMs: number,
  text: string,
): DubPlacedLine => ({
  index,
  action: "keep",
  rate: 1,
  text,
  startMs,
  endMs,
  durationMs: endMs - startMs,
  audioFile: `lines/${String(index).padStart(4, "0")}.mp3`,
});

const scriptLine = (index: number, sourceText: string): DubScriptLine => ({
  index,
  startMs: 0,
  endMs: 0,
  targetDurationMs: 0,
  text: "占位",
  sourceText,
  cueIndices: [index],
});

describe("buildReverseSrtCues", () => {
  it("maps one cue per non-empty placed line, pairing zh with the same-index utterance's English", () => {
    const cues = buildReverseSrtCues(
      [placed(1, 0, 900, "第一句"), placed(2, 1200, 2000, "第二句")],
      [scriptLine(1, "First sentence."), scriptLine(2, "Second sentence.")],
    );
    expect(cues).toEqual([
      { index: 1, startMs: 0, endMs: 900, zhText: "第一句", enText: "First sentence." },
      { index: 2, startMs: 1200, endMs: 2000, zhText: "第二句", enText: "Second sentence." },
    ]);
  });

  it("leaves enText empty when no script line matches the placed line's index", () => {
    const cues = buildReverseSrtCues([placed(1, 0, 900, "第一句")], []);
    expect(cues).toEqual([{ index: 1, startMs: 0, endMs: 900, zhText: "第一句", enText: "" }]);
  });

  it("skips blank text and pushes overlapping starts forward", () => {
    const cues = buildReverseSrtCues(
      [placed(1, 0, 1000, "甲"), placed(2, 800, 1500, "乙"), placed(3, 1600, 2000, "   ")],
      [scriptLine(1, "A"), scriptLine(2, "B"), scriptLine(3, "C")],
    );
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ startMs: 1000, endMs: 1500, zhText: "乙", enText: "B" });
  });

  it("guarantees end > start even for zero-duration input", () => {
    const cues = buildReverseSrtCues([placed(1, 500, 500, "空时长")], [scriptLine(1, "Empty")]);
    expect(cues[0]!.endMs).toBeGreaterThan(cues[0]!.startMs);
  });

  it("subdivides a long utterance into several contiguous display cues that reassemble the source zh/en", () => {
    const zh =
      "这是一句非常非常长的中文配音稿，用来测试屏宽切分是否能够把它拆成好几条显示单元，" +
      "并且保证每一条都不会超过屏幕能显示的最大宽度。";
    const en =
      "This is a very long dubbed sentence meant to test whether width-based splitting " +
      "can break it into several display cues, each staying within the screen's max width.";
    const cues = buildReverseSrtCues([placed(1, 10_000, 18_000, zh)], [scriptLine(1, en)]);

    expect(cues.length).toBeGreaterThan(1);
    expect(cues[0]!.startMs).toBe(10_000);
    expect(cues[cues.length - 1]!.endMs).toBe(18_000);
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.startMs).toBe(cues[i - 1]!.endMs);
    }
    expect(cues.map((c) => c.zhText).join("")).toBe(zh);
    expect(
      cues
        .map((c) => c.enText)
        .join(" ")
        .replace(/\s+/gu, " ")
        .trim(),
    ).toBe(en);
  });
});

describe("formatReverseSrt", () => {
  it("emits Chinese on the first line and English on the second, matching the bilingual burn convention", () => {
    const srt = formatReverseSrt(
      [placed(1, 0, 900, "你好"), placed(2, 1000, 2500, "世界")],
      [scriptLine(1, "Hello"), scriptLine(2, "World")],
    );
    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:00,900",
        "你好",
        "Hello",
        "",
        "2",
        "00:00:01,000 --> 00:00:02,500",
        "世界",
        "World",
        "",
      ].join("\n"),
    );
  });

  it("omits the English line entirely when no source text is available", () => {
    const srt = formatReverseSrt([placed(1, 0, 900, "你好")], []);
    expect(srt).toBe(["1", "00:00:00,000 --> 00:00:00,900", "你好", ""].join("\n"));
  });

  it("returns empty string when there are no cues", () => {
    expect(formatReverseSrt([], [])).toBe("");
    expect(formatReverseSrt([placed(1, 0, 100, "  ")], [scriptLine(1, "x")])).toBe("");
  });
});
