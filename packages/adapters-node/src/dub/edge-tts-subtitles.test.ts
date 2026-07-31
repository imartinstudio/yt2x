import { describe, expect, it } from "vitest";
import { parseEdgeTtsSubtitles } from "./edge-tts-subtitles.js";

/**
 * 真实 edge-tts --write-subtitles 样本（SRT 风格，逗号分隔毫秒；
 * 首 cue 起点即前置 padding）。
 */
const REAL_SAMPLE = `1
00:00:00,100 --> 00:00:01,712
你好世界。

2
00:00:01,662 --> 00:00:03,500
这是第二句。
`;

describe("parseEdgeTtsSubtitles", () => {
  it("reads speech start/end from the first and last cue", () => {
    const timing = parseEdgeTtsSubtitles(REAL_SAMPLE);
    expect(timing.speechStartMs).toBe(100);
    expect(timing.speechEndMs).toBe(3_500);
    expect(timing.speechDurationMs).toBe(3_400);
  });

  it("keeps cue boundaries for debugging", () => {
    const timing = parseEdgeTtsSubtitles(REAL_SAMPLE);
    expect(timing.cues).toEqual([
      { startMs: 100, endMs: 1_712, text: "你好世界。" },
      { startMs: 1_662, endMs: 3_500, text: "这是第二句。" },
    ]);
  });

  it("rejects empty subtitle output instead of inventing timing", () => {
    expect(() => parseEdgeTtsSubtitles("")).toThrow(/no usable cue/iu);
    expect(() => parseEdgeTtsSubtitles("WEBVTT\n\n")).toThrow(/no usable cue/iu);
  });

  it("rejects inverted cue ranges", () => {
    expect(() =>
      parseEdgeTtsSubtitles(`1
00:00:01,000 --> 00:00:00,500
坏
`),
    ).toThrow(/invalid cue/iu);
  });
});
