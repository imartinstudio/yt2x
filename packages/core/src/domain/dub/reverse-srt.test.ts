import { describe, expect, it } from "vitest";
import { buildReverseSrtCues, formatReverseSrt } from "./reverse-srt.js";
import type { DubPlacedLine } from "./types.js";

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

describe("buildReverseSrtCues", () => {
  it("maps one cue per non-empty placed line", () => {
    const cues = buildReverseSrtCues([
      placed(1, 0, 900, "第一句"),
      placed(2, 1200, 2000, "第二句"),
    ]);
    expect(cues).toEqual([
      { index: 1, startMs: 0, endMs: 900, text: "第一句" },
      { index: 2, startMs: 1200, endMs: 2000, text: "第二句" },
    ]);
  });

  it("skips blank text and pushes overlapping starts forward", () => {
    const cues = buildReverseSrtCues([
      placed(1, 0, 1000, "甲"),
      placed(2, 800, 1500, "乙"),
      placed(3, 1600, 2000, "   "),
    ]);
    expect(cues).toHaveLength(2);
    expect(cues[1]).toMatchObject({ startMs: 1000, endMs: 1500, text: "乙" });
  });

  it("guarantees end > start even for zero-duration input", () => {
    const cues = buildReverseSrtCues([placed(1, 500, 500, "空时长")]);
    expect(cues[0]!.endMs).toBeGreaterThan(cues[0]!.startMs);
  });
});

describe("formatReverseSrt", () => {
  it("emits standard SRT blocks", () => {
    const srt = formatReverseSrt([
      placed(1, 0, 900, "你好"),
      placed(2, 1000, 2500, "世界"),
    ]);
    expect(srt).toBe(
      [
        "1",
        "00:00:00,000 --> 00:00:00,900",
        "你好",
        "",
        "2",
        "00:00:01,000 --> 00:00:02,500",
        "世界",
        "",
      ].join("\n"),
    );
  });

  it("returns empty string when there are no cues", () => {
    expect(formatReverseSrt([])).toBe("");
    expect(formatReverseSrt([placed(1, 0, 100, "  ")])).toBe("");
  });
});
